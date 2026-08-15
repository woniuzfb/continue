import {
  ActionReducerMapBuilder,
  AsyncThunk,
  PayloadAction,
  createSelector,
  createSlice,
} from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ApplyState,
  AssistantChatMessage,
  BaseSessionMetadata,
  ChatHistoryItem,
  ChatMessage,
  ContextItem,
  ContextItemWithId,
  FileSymbolMap,
  McpUiState,
  MessageModes,
  PromptLog,
  RuleMetadata,
  Session,
  ThinkingChatMessage,
  Tool,
  ToolCallDelta,
  ToolCallState,
} from "core";
import { mergeReasoningDetails } from "core/llm/openaiTypeConverters";
import { NEW_SESSION_TITLE } from "core/util/constants";
import {
  renderChatMessage,
  renderContextItems,
} from "core/util/messageContent";
import { findUriInDirs, getUriPathBasename } from "core/util/uri";
import { findLastIndex } from "lodash";
import { v4 as uuidv4 } from "uuid";
import { type InlineErrorMessageType } from "../../components/mainInput/InlineErrorMessage";
import { toolCallCtxItemToCtxItemWithId } from "../../pages/gui/ToolCallDiv/utils";
import { addToolCallDeltaToState, isEditTool } from "../../util/toolCallState";
import { RootState } from "../store";
import { streamResponseThunk } from "../thunks/streamResponse";
import { findChatHistoryItemByToolCallId, findToolCallById } from "../util";

/**
 * Helper function to filter out duplicate edit/search-replace tool calls.
 * Only keeps the first occurrence of edit tools.
 *
 * We don't support multiple parallel apply calls - see tool definitions for
 * instructions we provide to models to prevent this behavior.
 */
function filterMultipleEditToolCalls(
  toolCalls: ToolCallDelta[],
): ToolCallDelta[] {
  let hasSeenEditTool = false;

  return toolCalls.filter((toolCall) => {
    if (toolCall.function?.name && isEditTool(toolCall.function?.name)) {
      if (hasSeenEditTool) {
        return false; // Skip this duplicate edit tool
      }
      hasSeenEditTool = true;
    }

    return true;
  });
}

/**
 * Initializes tool call states for a new message containing tool calls.
 * This function is called when we receive a complete message with tool calls,
 * typically in non-streaming scenarios or when processing the first chunk
 * of a streaming message that contains tool calls.
 *
 * @param message - The chat message containing tool calls to process
 * @param lastItem - The chat history item to attach tool call states to
 */
export function handleToolCallsInMessage(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    (message.role === "assistant" || message.role === "thinking") &&
    message.toolCalls?.length
  ) {
    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Initialize tool call states for each filtered tool call in the message
    // Each tool call gets its own state to track generation/execution progress
    lastItem.toolCallStates = filteredToolCalls.map((toolCallDelta) =>
      addToolCallDeltaToState(toolCallDelta, undefined),
    );

    // Update the message's toolCalls array to reflect the processed tool calls
    // We can safely cast because we verified the role above
    const curMessage = lastItem.message as
      | AssistantChatMessage
      | ThinkingChatMessage;
    curMessage.toolCalls = lastItem.toolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

/**
 * Applies a single tool call delta to the tool call states array.
 *
 * This function handles the core logic for OpenAI-style tool call streaming where:
 * - Initial tool calls come with full details (ID, name, arguments)
 * - Subsequent argument fragments come without IDs and need to update the most recent tool call
 * - Multiple parallel tool calls can be streamed simultaneously
 *
 * @param toolCallDelta - The incoming tool call delta from the LLM stream
 * @param toolCallStates - Array of existing tool call states (modified in place)
 */
function applyToolCallDelta(
  toolCallDelta: ToolCallDelta,
  toolCallStates: ToolCallState[],
): void {
  // Find existing state by matching toolCallId - this ensures we update
  // the correct tool call even when multiple tool calls are being streamed
  let existingStateIndex = -1;

  if (toolCallDelta.id) {
    // Tool call has an ID - find by exact match
    // This handles: new tool calls or explicit updates to existing ones
    existingStateIndex = toolCallStates.findIndex(
      (state) => state.toolCallId === toolCallDelta.id,
    );
  } else {
    // No ID in delta (common in OpenAI streaming fragments)
    // Strategy: Update the most recently added tool call that's still being generated
    // This handles the pattern: initial tool call with ID, then fragments without ID
    existingStateIndex = toolCallStates.length - 1;

    // Ensure we have at least one tool call to update
    if (existingStateIndex < 0) {
      existingStateIndex = -1; // Will create new tool call
    }
  }

  const existingState =
    existingStateIndex >= 0 ? toolCallStates[existingStateIndex] : undefined;

  // Apply the delta to create an updated state (either updating existing or creating new)
  const updatedState = addToolCallDeltaToState(toolCallDelta, existingState);

  if (existingStateIndex >= 0) {
    // Update existing tool call state in place
    toolCallStates[existingStateIndex] = updatedState;
  } else {
    // Add new tool call state for a newly discovered tool call
    toolCallStates.push(updatedState);
  }
}

/**
 * Handles incremental updates to tool calls during streaming responses.
 * This function processes streaming deltas for tool calls, updating existing
 * tool call states or creating new ones as needed. It uses ID-based matching
 * to ensure tool call updates are applied to the correct tool call state.
 *
 * @param message - The streaming message chunk containing tool call deltas
 * @param lastItem - The chat history item containing existing tool call states
 */
export function handleStreamingToolCallUpdates(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    message.role === "assistant" &&
    message.toolCalls?.length &&
    lastItem.message.role === "assistant"
  ) {
    // Start with existing tool call states or empty array if none exist
    const existingToolCallStates = lastItem.toolCallStates || [];
    const updatedToolCallStates: ToolCallState[] = [...existingToolCallStates];

    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Process each filtered tool call delta, matching by ID to update the correct state
    filteredToolCalls.forEach((toolCallDelta) => {
      applyToolCallDelta(toolCallDelta, updatedToolCallStates);
    });

    // Replace the entire tool call states array with the updated version
    lastItem.toolCallStates = updatedToolCallStates;

    // Update the message's toolCalls array to reflect current tool call states
    (lastItem.message as any).toolCalls = updatedToolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

// We need this to handle reorderings (e.g. a mid-array deletion) of the messages array.
// The proper fix is adding a UUID to all chat messages, but this is the temp workaround.
export type ChatHistoryItemWithMessageId = ChatHistoryItem & {
  message: ChatMessage & { id: string };
};

/**
 * context 指标快照（用于持久化到 session 文件 / LRU 缓存）。
 * 不含 compiledChatMessages，避免 session 文件体积膨胀和重复持久化文件内容。
 */
export type ContextMetricsSnapshot = {
  didPrune: boolean;
  contextPercentage: number;
  inputTokens?: number;
  contextLength?: number;
};

// ── Session LRU cache ──────────────────────────────────────────────
// When switching tabs, the in-memory session state (including lazily-loaded
// full history) would be lost. This cache preserves the state so switching
// back restores it without re-reading from disk.
const MAX_CACHED_SESSIONS = 5;

export type CachedSession = {
  sessionId: string;
  title: string;
  history: ChatHistoryItemWithMessageId[];
  mode: MessageModes;
  chatModelTitle?: string | null;
  hasReasoningEnabled?: boolean;
  // 缓存时该会话是否正在流式响应（切回时恢复 Stop 按钮状态）
  isStreaming?: boolean;
  // Lazy-load pagination state
  historyTruncated?: boolean;
  historyLoadedOffset?: number;
  historyTotalCount?: number;
  hasMoreHistory?: boolean;
  loadedDiskCount?: number;
  dontMergeReplyBubbles?: boolean;
  dontMergeHistoricalReplyBubbles?: boolean;
  // 缓存副本是否有未持久化变更（后台续流置脏，saveSessionFromCache 清零）
  dirty?: boolean;
  // Context metrics
  isPruned?: boolean;
  contextPercentage?: number;
  contextInputTokens?: number;
  contextLength?: number;
  // 最近一次 LLM 调用后的 context 指标快照（用于持久化/缓存恢复）
  contextMetrics?: ContextMetricsSnapshot;
  // Draft & symbols
  mainEditorDraft?: JSONContent | undefined;
  symbols: FileSymbolMap;
};

const sessionCacheMap = new Map<string, CachedSession>();

/** Read a cached session (LRU: marks as most-recently-used). */
export function getCachedSession(sessionId: string): CachedSession | undefined {
  const cached = sessionCacheMap.get(sessionId);
  if (cached) {
    // Move to end (most recently used)
    sessionCacheMap.delete(sessionId);
    sessionCacheMap.set(sessionId, cached);
  }
  return cached;
}

/** Store a session in the cache, evicting the oldest if at capacity. */
export function setCachedSession(
  sessionId: string,
  session: CachedSession,
): void {
  if (sessionCacheMap.has(sessionId)) {
    sessionCacheMap.delete(sessionId);
  } else if (sessionCacheMap.size >= MAX_CACHED_SESSIONS) {
    const oldestKey = sessionCacheMap.keys().next().value;
    if (oldestKey) {
      sessionCacheMap.delete(oldestKey);
    }
  }
  sessionCacheMap.set(sessionId, session);
}

/** Remove a session from the cache (e.g. when deleted). */
export function deleteCachedSession(sessionId: string): void {
  sessionCacheMap.delete(sessionId);
}

/**
 * 正在进行的流式请求的 AbortController 注册表。
 * 切换会话不再 abort 旧流的 controller（旧流转入后台继续跑）；
 * 只有用户主动取消（abortStream / cancelStream）时才统一 abort 所有在跑流。
 */
const activeStreamAborters = new Set<AbortController>();

export function registerStreamAborter(aborter: AbortController): void {
  activeStreamAborters.add(aborter);
}

export function unregisterStreamAborter(aborter: AbortController): void {
  activeStreamAborters.delete(aborter);
}

type SessionState = {
  lastSessionId?: string;
  isSessionMetadataLoading: boolean;
  allSessionMetadata: BaseSessionMetadata[];
  history: ChatHistoryItemWithMessageId[];
  isStreaming: boolean;
  title: string;
  id: string;
  streamAborter: AbortController;
  mainEditorContentTrigger?: JSONContent | undefined;
  // Draft content of the main input editor, preserved across route changes
  // (e.g. navigating to /history or /config and back) so the user's in-progress
  // input is not lost when the Chat route unmounts.
  mainEditorDraft?: JSONContent | undefined;
  symbols: FileSymbolMap;
  mode: MessageModes;
  isInEdit: boolean;
  codeBlockApplyStates: {
    states: ApplyState[];
    curIndex: number;
  };
  newestToolbarPreviewForInput: Record<string, string>;
  hasReasoningEnabled?: boolean;
  isPruned?: boolean;
  contextPercentage?: number;
  contextInputTokens?: number;
  contextLength?: number;
  // 最近一次 LLM 调用后的 context 指标快照；与 contextPercentage 等字段冗余存储，
  // 用于 saveCurrentSession 持久化到 session 文件，加载时直接还原。
  contextMetrics?: ContextMetricsSnapshot;
  inlineErrorMessage?: InlineErrorMessageType;
  compactionLoading: Record<number, boolean>; // Track compaction loading by message index
  // 懒加载分页状态
  historyTruncated?: boolean; // 当前 history 是否仅部分加载
  historyLoadedOffset?: number; // 头部未加载条数（全局）
  historyTotalCount?: number; // 磁盘上完整 history 总条数
  hasMoreHistory?: boolean; // 是否还有更早的消息可加载
  isHistoryLoading?: boolean; // 是否正在加载更多历史
  // 已从磁盘加载的条目数（懒加载时有效）。分页偏移以此为准而非
  // history.length，因此“轮次内合并”（mergeSplitReplies 减少条目数）
  // 不会破坏翻页记账。全量加载后清空。
  loadedDiskCount?: number;
  // UI 设置镜像：dontMergeReplyBubbles（默认 true=流式不合并气泡）、
  // dontMergeHistoricalReplyBubbles（默认 true=历史会话加载不合并）。
  // 由 Layout 监听 config.ui 同步。
  dontMergeReplyBubbles?: boolean;
  dontMergeHistoricalReplyBubbles?: boolean;
  // 内存会话是否有未持久化到磁盘的变更（history/title/contextMetrics）。
  // false 时 saveCurrentSession 跳过 history/save —— 消除切 tab 时对
  // 未变更会话的全量 clone + 写盘（长会话 ~2s 的 IPC 排队阻塞）。
  // 分页加载（prepend/loadFullHistory）只读不写盘，不置脏。
  dirty?: boolean;
};

/**
 * Repair old sessions written before the mid-response-thinking fix: a single
 * reply could be split across several history items
 * (`assistant → thinking → assistant …`), leaving the copy button with only
 * the trailing fragment.
 *
 * Within each reply group (consecutive assistant/thinking items between
 * user/tool messages), if MORE THAN ONE assistant item carries content, the
 * whole group is merged into a single assistant item: contents are
 * concatenated in stream order (faithfully restoring the original reply,
 * including mid-sentence cuts), and thinking texts are moved into
 * `reasoning`. Normal flows (empty placeholder + thinking + one answer, or a
 * single content-bearing assistant) are left untouched. Idempotent.
 *
 * The FIRST reply group (the first assistant/thinking run after the first
 * user message) is exempt: servers may derive the session ID from the
 * first-turn content, so that turn must stay byte-identical across reloads.
 * (With lazy-load prepends, the true first turn is only ever the first
 * group once the oldest page is loaded — intermediate groups get merged as
 * soon as an older page arrives, so everything converges.)
 */
export function mergeSplitReplies(
  history: ChatHistoryItemWithMessageId[],
): ChatHistoryItemWithMessageId[] {
  const result: ChatHistoryItemWithMessageId[] = [];
  let group: ChatHistoryItemWithMessageId[] = [];
  let isFirstGroup = true;

  const flush = () => {
    if (!group.length) {
      return;
    }
    const isFirst = isFirstGroup;
    isFirstGroup = false;

    if (isFirst) {
      // 首轮保持原样：服务端可能依据首轮对话内容确定会话 ID，
      // 这一轮必须跨重载保持字节一致。
      result.push(...group);
      group = [];
      return;
    }

    const contentItems = group.filter(
      (i) =>
        i.message.role === "assistant" &&
        renderChatMessage(i.message).trim().length > 0,
    );
    if (contentItems.length <= 1) {
      result.push(...group);
      group = [];
      return;
    }

    const contents = contentItems.map((i) => renderChatMessage(i.message));
    const thinkingTexts = group
      .filter((i) => i.message.role === "thinking")
      .map((i) => renderChatMessage(i.message).trim())
      .filter(Boolean);
    const assistantItems = group.filter((i) => i.message.role === "assistant");
    const firstAssistant = assistantItems[0] ?? group[0];

    // 拆分回复里 tool call 可能落在后面的 assistant 条目上
    // （流式顺序：text → thinking → text + toolCall），合并时不能只保留
    // firstAssistant 的 toolCalls / toolCallStates，否则工具调用链会断。
    const allToolCallStates = assistantItems.flatMap(
      (i) => i.toolCallStates ?? [],
    );
    const allToolCalls = assistantItems.flatMap(
      (i) => (i.message as any).toolCalls ?? [],
    );
    // 组内第一条 thinking 的签名/redacted/reasoning_details 原样保留到合并
    // 后的 message 上：当前 GUI 流程（constructMessages 过滤 thinking +
    // precompiled）不会把它们发给 LLM，但合并不应销毁这些数据——例如
    // Anthropic extended thinking 的签名块依赖 role==="thinking" 条目，
    // 若未来发送路径改为不过滤 thinking，这些字段仍然可用。assistant 分支
    // 的转换器不读这些字段，保留在 message 上无副作用。
    const firstThinking = group.find((i) => i.message.role === "thinking")
      ?.message as any;

    result.push({
      ...firstAssistant,
      toolCallStates: allToolCallStates.length
        ? allToolCallStates
        : firstAssistant.toolCallStates,
      message: {
        ...firstAssistant.message,
        content: contents.join(""),
        toolCalls: allToolCalls.length
          ? allToolCalls
          : (firstAssistant.message as any).toolCalls,
        ...(firstThinking?.signature
          ? { signature: firstThinking.signature }
          : {}),
        ...(firstThinking?.redactedThinking
          ? { redactedThinking: firstThinking.redactedThinking }
          : {}),
        ...(firstThinking?.reasoning_details
          ? { reasoning_details: firstThinking.reasoning_details }
          : {}),
      },
      // endAt 必须设置：StepContainer 用 !reasoning.endAt 判断“思考中”，
      // 置空会让已完成的回复永远显示 in-progress。thinking 条目不带时间戳，
      // 合并时刻的 Date.now() 是当前可得的最佳值。
      reasoning: thinkingTexts.length
        ? {
            text: thinkingTexts.join("\n\n"),
            startAt: firstAssistant.reasoning?.startAt ?? Date.now(),
            endAt: firstAssistant.reasoning?.endAt ?? Date.now(),
            active: false,
          }
        : firstAssistant.reasoning,
    } as ChatHistoryItemWithMessageId);
    group = [];
  };

  for (const item of history) {
    const role = item.message.role;
    if (role === "assistant" || role === "thinking") {
      group.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}

/**
 * streamUpdate 的目标对象：既能是 session slice 的 state（正常流），
 * 也能是 LRU 缓存里的 CachedSession（后台续流时，流所属会话已切走）。
 */
export type StreamUpdateTarget = {
  history: ChatHistoryItemWithMessageId[];
  isPruned?: boolean;
  contextPercentage?: number;
  contextInputTokens?: number;
  contextLength?: number;
  // UI 设置：默认 true=不合并气泡。true 时 thinking 之后的 assistant 内容
  // 保持原有行为（新建条目），false 时才续接前一个 assistant 条目。
  dontMergeReplyBubbles?: boolean;
};

/**
 * 纯函数版 streamUpdate：把流式消息合并进目标 history。
 * 从原 reducer 提取，保证正常流与后台续流走同一套合并逻辑。
 */
export function applyStreamUpdatesToHistory(
  target: StreamUpdateTarget,
  messages: ChatMessage[],
): void {
  if (!target.history.length) {
    return;
  }
  for (const message of messages) {
    // Handle metadata-only messages (yielded by BaseLLM.streamChat when
    // the backend compiles non-precompiled messages). These carry context
    // pruning info so the frontend doesn't need a separate compile request.
    if (
      message.role === "assistant" &&
      message.content === "" &&
      "metadata" in message &&
      message.metadata &&
      ("didPrune" in message.metadata ||
        "contextPercentage" in message.metadata)
    ) {
      target.isPruned = !!(message.metadata as any).didPrune;
      target.contextPercentage =
        (message.metadata as any).contextPercentage ?? 0;
      target.contextInputTokens = (message.metadata as any).contextInputTokens;
      target.contextLength = (message.metadata as any).contextLength;
      continue;
    }

    let lastItem = target.history[target.history.length - 1];
    let lastMessage = lastItem.message;

    if (message.role === "thinking" && message.redactedThinking) {
      target.history.push({
        message: {
          role: "thinking",
          content: "internal reasoning is hidden due to safety reasons",
          redactedThinking: message.redactedThinking,
          id: uuidv4(),
        },
        contextItems: [],
      });
      continue;
    }

    const messageContent = message.content ? renderChatMessage(message) : "";

    // OpenAI-compatible models in agent mode sometimes send
    // all of their data in one message, so we handle that case early.
    if (messageContent && message.role !== "tool") {
      const thinkMatches = messageContent.match(
        /<think>([\s\S]*)<\/think>([\s\S]*)/,
      );
      if (thinkMatches) {
        // The order that they seem to consistently use is:
        //
        // <think>Thinking text</think>
        // Text to show to the user

        lastItem.reasoning = {
          text: thinkMatches[1].trim(),
          startAt: Date.now(),
          endAt: Date.now(),
          active: false,
        };

        // This is the chat message that we should show to the user.
        // We always need to push this even if it is empty,
        // because we cannot attach tool calls to a Thinking message.
        // That would break `messageHasToolCallId`.
        target.history.push({
          message: {
            role: "assistant",
            content: thinkMatches[2].trim(),
            id: uuidv4(),
          },
          contextItems: [],
        });
        lastItem = target.history[target.history.length - 1];
        lastMessage = lastItem.message;

        handleToolCallsInMessage(message, lastItem);

        return;
      }
    }

    // The remainder of this function handles streaming messages
    if (
      lastMessage.role !== message.role ||
      message.role === "tool" // Tool messages should always create new messages
    ) {
      // A thinking message can arrive MID-response: the model has already
      // streamed answer text, then emits an extra reasoning block, then
      // keeps streaming the answer. When bubble merging is enabled
      // (dontMergeReplyBubbles=false), the following assistant content must
      // CONTINUE the previous assistant item instead of starting a new one —
      // otherwise one reply is split across multiple history items. The
      // guard on non-empty previous content keeps the normal
      // reasoning_content flow (thinking arrives BEFORE the answer, previous
      // placeholder is empty) exactly as before. When dontMergeReplyBubbles
      // is true (default), bubbles stay split and the copy button fallback
      // handles the complete reply.
      if (
        !(target.dontMergeReplyBubbles ?? true) &&
        message.role === "assistant" &&
        lastMessage.role === "thinking"
      ) {
        const prevItem = target.history[target.history.length - 2];
        if (
          prevItem &&
          prevItem.message.role === "assistant" &&
          renderChatMessage(prevItem.message).trim().length > 0
        ) {
          lastItem = prevItem;
          lastMessage = prevItem.message;
        }
      }

      if (lastMessage.role !== message.role || message.role === "tool") {
        // Create a new message
        const historyItem: ChatHistoryItemWithMessageId = {
          message: {
            ...message,
            content: "", // Start with empty content, let accumulation logic handle it
            id: uuidv4(),
          },
          contextItems: [],
        };
        target.history.push(historyItem);
        lastItem = target.history[target.history.length - 1];
        lastMessage = lastItem.message;
      }
    }

    // Add to the existing message
    if (messageContent) {
      if (messageContent.includes("<think>") && message.role !== "tool") {
        lastItem.reasoning = {
          startAt: Date.now(),
          active: true,
          text: messageContent.replace("<think>", "").trim(),
        };
      } else if (
        lastItem.reasoning?.active &&
        messageContent.includes("</think>")
      ) {
        const [reasoningEnd, answerStart] = messageContent.split("</think>");
        lastItem.reasoning.text += reasoningEnd.trimEnd();
        lastItem.reasoning.active = false;
        lastItem.reasoning.endAt = Date.now();
        lastMessage.content += answerStart.trimStart();
      } else if (lastItem.reasoning?.active) {
        if (
          lastItem.reasoning.text.length > 0 ||
          messageContent.trim().length > 0
        ) {
          lastItem.reasoning.text += messageContent;
        }
      } else {
        // Note this only works because new message above
        // was already rendered from parts to string
        if (
          lastMessage.content.length > 0 ||
          messageContent.trim().length > 0
        ) {
          lastMessage.content += messageContent;
        }
      }
    } else if (message.role === "thinking" && message.signature) {
      if (lastMessage.role === "thinking") {
        lastMessage.signature = message.signature;
      }
    } else if (
      message.role === "assistant" &&
      message.toolCalls?.length &&
      lastMessage.role === "assistant"
    ) {
      handleStreamingToolCallUpdates(message, lastItem);
    }

    // Attach Responses API output item id to the current assistant message if present
    // fromResponsesChunk sets message.metadata.responsesOutputItemId when it sees output_item.added for messages
    if (
      message.role === "assistant" &&
      lastMessage.role === "assistant" &&
      message.metadata?.responsesOutputItemId
    ) {
      lastMessage.metadata = lastMessage.metadata || {};
      // Accumulate fc_ IDs for parallel tool calls (OpenAI Responses API)
      if (!lastMessage.metadata.responsesOutputItemIds) {
        lastMessage.metadata.responsesOutputItemIds = [];
      }
      (lastMessage.metadata.responsesOutputItemIds as string[]).push(
        message.metadata.responsesOutputItemId as string,
      );
      // Also keep singular for backwards compatibility
      lastMessage.metadata.responsesOutputItemId = message.metadata
        .responsesOutputItemId as string;
    }

    if (
      message.role === "thinking" &&
      message.reasoning_details &&
      lastMessage.role === "thinking"
    ) {
      lastMessage.reasoning_details = mergeReasoningDetails(
        lastMessage.reasoning_details,
        message.reasoning_details,
      );
    }
  }
}

export const INITIAL_SESSION_STATE: SessionState = {
  isSessionMetadataLoading: false,
  allSessionMetadata: [],
  history: [],
  isStreaming: false,
  title: NEW_SESSION_TITLE,
  id: uuidv4(),
  streamAborter: new AbortController(),
  symbols: {},
  mode: "agent",
  isInEdit: false,
  codeBlockApplyStates: {
    states: [],
    curIndex: 0,
  },
  lastSessionId: undefined,
  newestToolbarPreviewForInput: {},
  compactionLoading: {},
  dontMergeReplyBubbles: true,
  dontMergeHistoricalReplyBubbles: true,
};

export const sessionSlice = createSlice({
  name: "session",
  initialState: INITIAL_SESSION_STATE,
  reducers: {
    addPromptCompletionPair: (
      state,
      { payload }: PayloadAction<PromptLog[]>,
    ) => {
      if (!state.history.length) {
        return;
      }
      state.dirty = true;

      const lastMessage = state.history[state.history.length - 1];

      lastMessage.promptLogs = lastMessage.promptLogs
        ? lastMessage.promptLogs.concat(payload)
        : payload;

      // Inactive thinking for reasoning models when '</think>' tag is not received on request completion
      if (lastMessage.reasoning?.active) {
        lastMessage.reasoning.active = false;
        lastMessage.reasoning.endAt = Date.now();
      }
    },
    setActive: (state) => {
      state.isStreaming = true;
    },
    /**
     * 持久化成功后清除脏标记（saveCurrentSession 成功回调 dispatch）。
     * 带 sessionId 防竞态：await 期间用户可能已切到其他会话。
     */
    markSessionPersisted: (state, { payload }: PayloadAction<string>) => {
      if (state.id === payload) {
        state.dirty = false;
      }
    },
    /** Mark the current session for persistence when session-scoped config changes. */
    markSessionDirty: (state) => {
      if (state.history.length > 0) {
        state.dirty = true;
      }
    },
    setIsGatheringContext: (state, { payload }: PayloadAction<boolean>) => {
      const curMessage = state.history.at(-1);
      if (curMessage) {
        state.dirty = true;
        curMessage.isGatheringContext = payload;
      }
    },
    clearDanglingMessages: (state) => {
      state.dirty = true;
      // This is used during cancellation
      // After the last user or tool message, we can have thinking and or valid assitant message (content or generated tool calls) OR nothing.
      // The only thing allowed after the last assistant message that has either content or generated tool calls
      // is a user or tool message
      if (state.history.length < 2) {
        return;
      }

      const lastUserOrToolIdx = findLastIndex(
        state.history,
        (item) => item.message.role === "tool" || item.message.role === "user",
      );

      let validAssistantMessageIdx = -1;
      for (let i = state.history.length - 1; i > lastUserOrToolIdx; i--) {
        const message = state.history[i];
        const hasGeneratedMsg = message.toolCallStates?.some(
          (toolCallState) => toolCallState.status !== "generating",
        );
        if (message.message.content || hasGeneratedMsg) {
          validAssistantMessageIdx = i;
          // Cancel any tool calls that are dangling and generated
          if (message.toolCallStates) {
            message.toolCallStates.forEach((toolCallState) => {
              if (
                toolCallState.status === "generated" ||
                toolCallState.status === "generating"
              ) {
                toolCallState.status = "canceled";
              }
            });
          }
          break;
        }
      }

      if (validAssistantMessageIdx === -1) {
        const lastMsg = state.history[lastUserOrToolIdx];
        const lastRole = lastMsg.message.role as "user" | "tool";
        if (lastRole === "user") {
          state.mainEditorContentTrigger = lastMsg.editorState;
          state.history = state.history.slice(0, lastUserOrToolIdx);
        } else {
          state.history = state.history.slice(0, lastUserOrToolIdx + 1);
        }
      } else {
        state.history = state.history.slice(0, validAssistantMessageIdx + 1);
      }
    },
    // Trigger value picked up by editor with isMainInput to set its content
    setMainEditorContentTrigger: (
      state,
      action: PayloadAction<JSONContent | undefined>,
    ) => {
      state.mainEditorContentTrigger = action.payload;
    },
    // Persist/restore the main input draft across route changes
    setMainEditorDraft: (
      state,
      action: PayloadAction<JSONContent | undefined>,
    ) => {
      state.mainEditorDraft = action.payload;
    },
    updateFileSymbols: (state, action: PayloadAction<FileSymbolMap>) => {
      state.symbols = {
        ...state.symbols,
        ...action.payload,
      };
    },
    setContextItemsAtIndex: (
      state,
      {
        payload: { index, contextItems },
      }: PayloadAction<{
        index: number;
        contextItems: ChatHistoryItem["contextItems"];
      }>,
    ) => {
      if (state.history[index]) {
        state.dirty = true;
        state.history[index].contextItems = contextItems;
      }
    },
    submitEditorAndInitAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        editorState: JSONContent;
      }>,
    ) => {
      const { index, editorState } = payload;
      state.dirty = true;

      if (state.history.length && index < state.history.length) {
        // Resubmission - update input message, truncate history after resubmit with new empty response message
        if (index % 2 === 1) {
          console.warn(
            "Corrupted history: resubmitting at odd index, shouldn't happen",
          );
        }
        const historyItem = state.history[index];

        historyItem.message.content = ""; // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
        historyItem.editorState = payload.editorState;
        historyItem.contextItems = [];

        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
        });
      } else {
        // New input/response messages
        state.history = state.history.concat([
          {
            message: {
              id: uuidv4(),
              role: "user",
              content: "", // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
            },
            contextItems: [],
            editorState,
          },
          {
            message: {
              id: uuidv4(),
              role: "assistant",
              content: "", // IMPORTANT - this is subsequently updated by response streaming
            },
            contextItems: [],
          },
        ]);
      }

      state.isStreaming = true;
    },
    truncateHistoryToMessage: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
      }>,
    ) => {
      const { index } = payload;
      state.dirty = true;

      if (state.history.length && index < state.history.length) {
        state.codeBlockApplyStates.curIndex = 0;
        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
        });
        state.inlineErrorMessage = undefined;
        state.isPruned = false;
        state.contextPercentage = undefined;
        // 历史被截断后，旧 context 指标已 stale
        state.contextMetrics = undefined;
      }
    },
    deleteMessage: (state, action: PayloadAction<number>) => {
      // Deletes the current assistant message and the previous user message
      state.dirty = true;
      state.history.splice(action.payload - 1, 2);
      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.contextInputTokens = undefined;
      state.contextLength = undefined;
      // 历史被删除后，旧 context 指标已 stale
      state.contextMetrics = undefined;
    },
    deleteCompaction: (state, action: PayloadAction<number>) => {
      // Removes the conversation summary from the specified message
      const historyItem = state.history[action.payload];
      if (historyItem?.conversationSummary) {
        state.dirty = true;
        state.history[action.payload] = {
          ...historyItem,
          conversationSummary: undefined,
        };
      }
    },
    updateHistoryItemAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        updates: Partial<ChatHistoryItemWithMessageId>;
      }>,
    ) => {
      const { index, updates } = payload;
      if (index !== 0 && !state.history[index]) {
        console.error(
          `attempting to update history item at nonexistent index ${index}`,
          updates,
        );
        return;
      }
      state.dirty = true;
      state.history[index] = {
        ...state.history[index],
        ...updates,
      };
      // 历史被编辑/重试后，旧 context 指标已 stale
      state.contextMetrics = undefined;
    },
    addContextItemsAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        contextItems: ContextItemWithId[];
      }>,
    ) => {
      const historyItem = state.history[payload.index];

      if (!historyItem) {
        return;
      }

      state.dirty = true;
      historyItem.contextItems = [
        ...historyItem.contextItems,
        ...payload.contextItems,
      ];
    },
    setAppliedRulesAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        appliedRules: RuleMetadata[];
      }>,
    ) => {
      if (state.history[payload.index]) {
        state.dirty = true;
        state.history[payload.index].appliedRules = payload.appliedRules;
      }
    },
    setInactive: (state) => {
      const curMessage = state.history.at(-1);

      if (curMessage?.isGatheringContext) {
        state.dirty = true;
        curMessage.isGatheringContext = false;
      }

      state.isStreaming = false;
    },
    abortStream: (state) => {
      // 取消所有仍在跑的流（包括切到其他会话后在后台继续的），
      // 再重置当前会话的 controller。
      for (const aborter of activeStreamAborters) {
        aborter.abort();
      }
      activeStreamAborters.clear();
      state.streamAborter.abort();
      state.streamAborter = new AbortController();
    },
    streamUpdate: (state, action: PayloadAction<ChatMessage[]>) => {
      // 提取为纯函数，供“后台续流”（流所属会话已切走）时把更新
      // 写入该会话的 LRU 缓存副本。
      state.dirty = true;
      applyStreamUpdatesToHistory(state, action.payload);
    },
    newSession: (state, { payload }: PayloadAction<Session | undefined>) => {
      state.lastSessionId = state.id;

      // 注意：这里不再 abort 旧 controller。切换/新建会话时，旧会话在跑的流
      // 转入后台继续（更新写入它的 LRU 缓存副本），由用户主动取消时统一 abort。
      state.streamAborter = new AbortController();

      state.isStreaming = false;
      state.symbols = {};

      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.contextInputTokens = undefined;
      state.contextLength = undefined;
      state.contextMetrics = undefined;
      // 重置懒加载分页状态
      state.historyTruncated = false;
      state.historyLoadedOffset = 0;
      state.historyTotalCount = undefined;
      state.hasMoreHistory = false;
      state.isHistoryLoading = false;
      state.loadedDiskCount = undefined;
      // 从磁盘/新建加载的内容与磁盘一致，干净
      state.dirty = false;

      if (payload) {
        // 合并的是“轮次内”的气泡块（user 之后连续的 assistant/thinking），
        // 与分页正交。分页偏移由 loadedDiskCount（已加载的磁盘条目数）记账，
        // 不依赖 history.length，所以懒加载/全量加载都可以安全合并。
        // 注意：loadedDiskCount 必须在合并前记录原始页条数。
        // 默认 dontMergeHistoricalReplyBubbles=true（历史会话不合并）。
        if (payload.historyTruncated) {
          state.loadedDiskCount = (payload.history as any[]).length;
        }
        state.history =
          (state.dontMergeHistoricalReplyBubbles ?? true)
            ? (payload.history as any)
            : mergeSplitReplies(payload.history as any);
        state.title = payload.title;
        state.id = payload.sessionId;
        if (payload.mode) {
          state.mode = payload.mode;
        }
        // 从 payload 继承分页元数据（loadSession 传入）
        if (payload.historyTruncated) {
          state.historyTruncated = true;
          state.historyLoadedOffset = payload.historyLoadedOffset ?? 0;
        }
        // 从 payload 恢复 context 指标快照（loadSession 传入）
        if (payload.contextMetrics) {
          state.contextMetrics = payload.contextMetrics;
          state.isPruned = payload.contextMetrics.didPrune;
          state.contextPercentage = payload.contextMetrics.contextPercentage;
          state.contextInputTokens = payload.contextMetrics.inputTokens;
          state.contextLength = payload.contextMetrics.contextLength;
        }
      } else {
        state.history = [];
        state.title = NEW_SESSION_TITLE;
        state.id = uuidv4();
      }
    },
    /**
     * 从 LRU 缓存恢复一个 session 的完整内存状态。
     * 与 newSession 不同，这里恢复所有缓存的字段（context 指标、
     * 分页状态、symbols、draft 等），避免切换 tab 后丢失。
     */
    restoreCachedSession: (
      state,
      { payload }: PayloadAction<CachedSession>,
    ) => {
      state.lastSessionId = state.id;

      // 不再 abort 旧 controller：切 tab 时旧流转入后台继续，
      // 只有用户主动取消才统一 abort（见 abortStream）。
      state.streamAborter = new AbortController();

      // 恢复该会话缓存时的 streaming 状态：切回一个正在后台跑的会话时，
      // Stop 按钮仍可见；普通会话为 false。
      state.isStreaming = payload.isStreaming ?? false;
      state.inlineErrorMessage = undefined;
      state.compactionLoading = {};
      state.codeBlockApplyStates = { states: [], curIndex: 0 };
      state.newestToolbarPreviewForInput = {};

      // 恢复缓存的字段
      state.id = payload.sessionId;
      state.title = payload.title;
      // 合并轮次内气泡块；分页偏移由 loadedDiskCount 记账，不受合并影响。
      // 默认 dontMergeHistoricalReplyBubbles=true（历史会话不合并）。
      state.history =
        (state.dontMergeHistoricalReplyBubbles ?? true)
          ? payload.history
          : mergeSplitReplies(payload.history);
      state.mode = payload.mode;
      state.symbols = payload.symbols || {};
      state.hasReasoningEnabled = payload.hasReasoningEnabled;
      // 懒加载分页状态
      state.historyTruncated = payload.historyTruncated;
      state.historyLoadedOffset = payload.historyLoadedOffset;
      state.historyTotalCount = payload.historyTotalCount;
      state.hasMoreHistory = payload.hasMoreHistory;
      state.loadedDiskCount = payload.loadedDiskCount;
      state.dontMergeReplyBubbles = payload.dontMergeReplyBubbles ?? true;
      state.dontMergeHistoricalReplyBubbles =
        payload.dontMergeHistoricalReplyBubbles ?? true;
      state.dirty = payload.dirty ?? false;
      state.isHistoryLoading = false;
      // Context 指标
      state.isPruned = payload.isPruned;
      state.contextPercentage = payload.contextPercentage;
      state.contextInputTokens = payload.contextInputTokens;
      state.contextLength = payload.contextLength;
      state.contextMetrics = payload.contextMetrics;
      // Draft
      state.mainEditorDraft = payload.mainEditorDraft;
    },
    /**
     * 在 history 头部 prepend 更早的消息（懒加载上滑时调用）。
     * 同时更新分页游标和 hasMore 标记。
     *
     * 竞态保护：如果 loadMoreHistory 的 IPC 往返期间 history 已被完整加载
     * （如用户在此期间发送消息触发 loadFullHistory），跳过 prepend，
     * 避免在已完整的 history 头部插入重复条目。
     */
    prependHistoryItems: (
      state,
      {
        payload,
      }: PayloadAction<{
        items: ChatHistoryItemWithMessageId[];
        hasMore: boolean;
        newLoadedOffset: number;
        totalCount: number;
      }>,
    ) => {
      // history 已完整加载（loadFullHistory 在 IPC 往返期间抢先完成），
      // 跳过 prepend 避免重复条目
      if (!state.historyTruncated) {
        state.isHistoryLoading = false;
        return;
      }
      // 合并轮次内的气泡块（可能跨页边界——组在内存中连续即可安全合并，
      // 分页偏移由 loadedDiskCount 记账）。必须先按磁盘页条数累加，再合并。
      // 默认 dontMergeHistoricalReplyBubbles=true（历史会话不合并）。
      state.loadedDiskCount =
        (state.loadedDiskCount ?? state.history.length) + payload.items.length;
      state.history =
        (state.dontMergeHistoricalReplyBubbles ?? true)
          ? [...payload.items, ...state.history]
          : mergeSplitReplies([...payload.items, ...state.history]);
      state.historyLoadedOffset = payload.newLoadedOffset;
      state.hasMoreHistory = payload.hasMore;
      state.historyTotalCount = payload.totalCount;
      state.historyTruncated = payload.hasMore;
      state.isHistoryLoading = false;
    },
    setIsHistoryLoading: (state, { payload }: PayloadAction<boolean>) => {
      state.isHistoryLoading = payload;
    },
    /**
     * UI 设置镜像：config.ui?.dontMergeReplyBubbles（默认 true=流式不合并气泡）。
     * 由 Layout 监听 config 变化后 dispatch。
     */
    setDontMergeReplyBubbles: (state, { payload }: PayloadAction<boolean>) => {
      state.dontMergeReplyBubbles = payload;
    },
    /**
     * UI 设置镜像：config.ui?.dontMergeHistoricalReplyBubbles
     * （默认 true=历史会话加载不合并气泡）。由 Layout 监听 config 变化后 dispatch。
     */
    setDontMergeHistoricalReplyBubbles: (
      state,
      { payload }: PayloadAction<boolean>,
    ) => {
      state.dontMergeHistoricalReplyBubbles = payload;
    },
    /**
     * 初始化分页元数据（loadSession 在懒加载模式下 dispatch）。
     */
    setHistoryPagination: (
      state,
      { payload }: PayloadAction<{ hasMore: boolean; totalCount: number }>,
    ) => {
      state.hasMoreHistory = payload.hasMore;
      state.historyTotalCount = payload.totalCount;
    },
    /**
     * 当 history 全量加载完成（无更多分页）时，清除 truncated 标记。
     */
    markHistoryFullyLoaded: (state) => {
      state.historyTruncated = false;
      state.hasMoreHistory = false;
      state.historyLoadedOffset = 0;
      state.loadedDiskCount = undefined;
    },
    /**
     * 发送新消息前加载完整 history（loadFullHistory thunk 调用）。
     * 直接替换 state.history 并清除所有分页标记。
     */
    setFullHistory: (
      state,
      { payload }: PayloadAction<ChatHistoryItemWithMessageId[]>,
    ) => {
      state.history =
        (state.dontMergeHistoricalReplyBubbles ?? true)
          ? payload
          : mergeSplitReplies(payload);
      state.historyTruncated = false;
      state.hasMoreHistory = false;
      state.historyLoadedOffset = 0;
      state.loadedDiskCount = undefined;
      state.isHistoryLoading = false;
    },
    updateSessionTitle: (state, { payload }: PayloadAction<string>) => {
      state.dirty = true;
      state.title = payload;
    },
    setIsSessionMetadataLoading: (
      state,
      { payload }: PayloadAction<boolean>,
    ) => {
      state.isSessionMetadataLoading = payload;
    },
    setAllSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata[]>,
    ) => {
      state.allSessionMetadata = payload;
    },
    //////////////////////////////////////////////////////////////////////////////////
    // These are for optimistic session metadata updates, especially for History page
    addSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata>,
    ) => {
      state.allSessionMetadata = [...state.allSessionMetadata, payload];
    },
    updateSessionMetadata: (
      state,
      {
        payload,
      }: PayloadAction<
        {
          sessionId: string;
        } & Partial<BaseSessionMetadata>
      >,
    ) => {
      state.allSessionMetadata = state.allSessionMetadata.map((session) =>
        session.sessionId === payload.sessionId
          ? {
              ...session,
              ...payload,
            }
          : session,
      );
      if (payload.title && payload.sessionId === state.id) {
        state.title = payload.title;
      }
    },
    deleteSessionMetadata: (state, { payload }: PayloadAction<string>) => {
      // Note, should not be allowed to delete current session from chat session
      state.allSessionMetadata = state.allSessionMetadata.filter(
        (session) => session.sessionId !== payload,
      );
    },
    //////////////////////////////////////////////////////////////////////////////////
    addHighlightedCode: (
      state,
      {
        payload,
      }: PayloadAction<{ rangeInFileWithContents: any; edit: boolean }>,
    ) => {
      let contextItems =
        state.history[state.history.length - 1].contextItems ?? [];

      contextItems = contextItems.map((item) => {
        return { ...item, editing: false };
      });

      const { relativePathOrBasename } = findUriInDirs(
        payload.rangeInFileWithContents.filepath,
        window.workspacePaths ?? [],
      );
      const fileName = getUriPathBasename(
        payload.rangeInFileWithContents.filepath,
      );

      const lineNums = `(${
        payload.rangeInFileWithContents.range.start.line + 1
      }-${payload.rangeInFileWithContents.range.end.line + 1})`;

      contextItems.push({
        name: `${fileName} ${lineNums}`,
        description: relativePathOrBasename,
        id: {
          providerTitle: "code",
          itemId: uuidv4(),
        },
        content: payload.rangeInFileWithContents.contents,
        editing: true,
        editable: true,
        uri: {
          type: "file",
          value: payload.rangeInFileWithContents.filepath,
        },
      });

      state.dirty = true;
      state.history[state.history.length - 1].contextItems = contextItems;
    },
    updateApplyState: (state, { payload }: PayloadAction<ApplyState>) => {
      const applyState = state.codeBlockApplyStates.states.find(
        (state) => state.streamId === payload.streamId,
      );

      if (!applyState) {
        state.codeBlockApplyStates.states.push(payload);
      } else {
        applyState.status = payload.status ?? applyState.status;
        applyState.numDiffs = payload.numDiffs ?? applyState.numDiffs;
        applyState.filepath = payload.filepath ?? applyState.filepath;
        applyState.fileContent = payload.fileContent ?? applyState.fileContent;
        applyState.originalFileContent =
          payload.originalFileContent ?? applyState.originalFileContent;
      }

      if (payload.status === "done") {
        state.codeBlockApplyStates.curIndex++;
      }
    },
    resetNextCodeBlockToApplyIndex: (state) => {
      state.codeBlockApplyStates.curIndex = 0;
    },

    // TOOL CALL STATE
    setToolGenerated: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        tools: Tool[];
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );

      if (toolCallState) {
        state.dirty = true;
        toolCallState.status = "generated";

        const tool = action.payload.tools.find(
          (t) => t.function.name === toolCallState.toolCall.function.name,
        );
        if (tool) {
          toolCallState.tool = tool;
        }
      }
    },
    updateToolCallOutput: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        contextItems: ContextItem[];
        mcpUiState?: McpUiState;
      }>,
    ) => {
      // Update tool call state and corresponding tool output message
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        state.dirty = true;
        toolCallState.output = action.payload.contextItems;
        toolCallState.mcpUiState = action.payload.mcpUiState;
      }
      const toolItem = findChatHistoryItemByToolCallId(
        state.history,
        action.payload.toolCallId,
      );
      if (toolItem) {
        toolItem.message.content = renderContextItems(
          action.payload.contextItems,
        );
        toolItem.contextItems = action.payload.contextItems.map((item) =>
          toolCallCtxItemToCtxItemWithId(item, action.payload.toolCallId),
        );
      }
    },
    setProcessedToolCallArgs: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        newArgs: Record<string, any>;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        state.dirty = true;
        toolCallState.processedArgs = action.payload.newArgs;
      }
    },
    cancelToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        state.dirty = true;
        toolCallState.status = "canceled";
      }
    },
    errorToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        output?: ContextItem[]; // optional for convenience
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        state.dirty = true;
        toolCallState.status = "errored";
        if (action.payload.output) {
          toolCallState.output = action.payload.output;
        }
      }
    },
    acceptToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        state.dirty = true;
        toolCallState.status = "done";
      }
    },
    setToolCallCalling: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        state.dirty = true;
        toolCallState.status = "calling";
      }
    },
    setMode: (state, action: PayloadAction<MessageModes>) => {
      // mode 持久化在 session 文件里
      state.dirty = true;
      state.mode = action.payload;
    },
    setIsInEdit: (state, action: PayloadAction<boolean>) => {
      state.isInEdit = action.payload;
    },
    setHasReasoningEnabled: (state, action: PayloadAction<boolean>) => {
      state.hasReasoningEnabled = action.payload;
    },
    setNewestToolbarPreviewForInput: (
      state,
      {
        payload,
      }: PayloadAction<{
        inputId: string;
        contextItemId: string;
      }>,
    ) => {
      state.newestToolbarPreviewForInput[payload.inputId] =
        payload.contextItemId;
    },
    setCompactionLoading: (
      state,
      action: PayloadAction<{ index: number; loading: boolean }>,
    ) => {
      const { index, loading } = action.payload;
      if (loading) {
        state.compactionLoading[index] = true;
      } else {
        delete state.compactionLoading[index];
      }
    },
    setInlineErrorMessage: (
      state,
      action: PayloadAction<SessionState["inlineErrorMessage"]>,
    ) => {
      state.inlineErrorMessage = action.payload;
    },
    setIsPruned: (state, action: PayloadAction<boolean>) => {
      state.isPruned = action.payload;
    },
    setContextPercentage: (state, action: PayloadAction<number>) => {
      state.contextPercentage = action.payload;
    },
    setContextInputTokens: (state, action: PayloadAction<number>) => {
      state.contextInputTokens = action.payload;
    },
    setContextLength: (state, action: PayloadAction<number>) => {
      state.contextLength = action.payload;
    },
    /**
     * 保存最近一次 LLM 调用后的 context 指标快照（不含 compiledChatMessages）。
     * streamNormalInput 拿到 compileChat 结果后 dispatch，
     * saveCurrentSession 会把它持久化到 session 文件。
     */
    setContextMetrics: (
      state,
      action: PayloadAction<ContextMetricsSnapshot>,
    ) => {
      state.dirty = true;
      state.contextMetrics = action.payload;
    },
    /**
     * 清除 context 指标快照（标记为 stale）。
     * 切换 model / 修改 rules / tools / 编辑历史消息时调用，
     * 下次发送消息后会重新计算并覆盖。
     */
    clearContextMetrics: (state) => {
      // 清除意味着旧快照 stale：跳过 save 会让磁盘残留过期 metrics，
      // 下次加载还原旧值，所以这里也算脏。
      state.dirty = true;
      state.contextMetrics = undefined;
    },
  },
  selectors: {
    selectIsGatheringContext: (state) => {
      const curHistoryItem = state.history.at(-1);
      return curHistoryItem?.isGatheringContext || false;
    },
  },
  extraReducers: (builder) => {
    addPassthroughCases(builder, [streamResponseThunk]);
  },
});

function addPassthroughCases(
  builder: ActionReducerMapBuilder<SessionState>,
  thunks: AsyncThunk<any, any, any>[],
) {
  thunks.forEach((thunk) => {
    builder
      .addCase(thunk.fulfilled, (_state, _action) => {})
      .addCase(thunk.rejected, (_state, _action) => {})
      .addCase(thunk.pending, (_state, _action) => {});
  });
}

export const selectApplyStateByStreamId = createSelector(
  [
    (state: RootState) => state.session.codeBlockApplyStates.states,
    (_state: RootState, streamId?: string) => streamId,
  ],
  (states, streamId) => {
    return states.find((state) => state.streamId === streamId);
  },
);

export const selectApplyStateByToolCallId = createSelector(
  [
    (state: RootState) => state.session.codeBlockApplyStates.states,
    (_state: RootState, toolCallId?: string) => toolCallId,
  ],
  (states, toolCallId) => {
    if (toolCallId) {
      return states.find((state) => state.toolCallId === toolCallId);
    }
  },
);

export const {
  updateFileSymbols,
  setContextItemsAtIndex,
  addContextItemsAtIndex,
  setAppliedRulesAtIndex,
  setInactive,
  streamUpdate,
  newSession,
  updateSessionTitle,
  addHighlightedCode,
  addPromptCompletionPair,
  setActive,
  submitEditorAndInitAtIndex,
  truncateHistoryToMessage,
  updateHistoryItemAtIndex,
  clearDanglingMessages,
  setMainEditorContentTrigger,
  setMainEditorDraft,
  deleteMessage,
  deleteCompaction,
  setIsGatheringContext,
  resetNextCodeBlockToApplyIndex,
  updateApplyState,
  abortStream,
  setToolCallCalling,
  cancelToolCall,
  errorToolCall,
  acceptToolCall,
  setToolGenerated,
  updateToolCallOutput,
  setProcessedToolCallArgs,
  setMode,
  setIsSessionMetadataLoading,
  setAllSessionMetadata,
  addSessionMetadata,
  updateSessionMetadata,
  deleteSessionMetadata,
  setNewestToolbarPreviewForInput,
  setIsInEdit,
  setHasReasoningEnabled,
  setInlineErrorMessage,
  setIsPruned,
  setContextPercentage,
  setContextInputTokens,
  setContextLength,
  setContextMetrics,
  clearContextMetrics,
  setCompactionLoading,
  prependHistoryItems,
  setIsHistoryLoading,
  setDontMergeReplyBubbles,
  setDontMergeHistoricalReplyBubbles,
  setHistoryPagination,
  markHistoryFullyLoaded,
  setFullHistory,
  restoreCachedSession,
  markSessionDirty,
  markSessionPersisted,
} = sessionSlice.actions;

export const { selectIsGatheringContext } = sessionSlice.selectors;

export default sessionSlice.reducer;
