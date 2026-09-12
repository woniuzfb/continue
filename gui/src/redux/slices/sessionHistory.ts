import { v4 as uuidv4 } from "uuid";
import {
  ApplyState,
  AssistantChatMessage,
  ChatHistoryItem,
  ChatMessage,
  ContextItemWithId,
  FileSymbolMap,
  MessageModes,
  ThinkingChatMessage,
  ToolCallDelta,
  ToolCallState,
} from "core";
import { mergeReasoningDetails } from "core/llm/openaiTypeConverters";
import { renderChatMessage } from "core/util/messageContent";
import { addToolCallDeltaToState, isEditTool } from "../../util/toolCallState";

/**
 * Session history helpers extracted from the legacy `sessionSlice`
 * (方案.md §五.3). They are pure functions over `ChatHistoryItemWithMessageId[]`
 * and are shared by the session runtime slice, the stream reducer and the
 * tests. No Redux state is involved.
 */

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

  // 方案.md §7.4: a fragment without an id creates a state whose `toolCallId` is "" (see
  // `addToolCallDeltaToState`). The next fragment that carries the real id matches nothing by id,
  // so this used to push a **second** state for one logical call — reproduced as
  // `[{toolCallId: ""}, {toolCallId: "call_1"}]`, which the approval bar renders as two rows for
  // one command (only the first row gets the key hints), and the "" row can never be resolved by
  // the real id. Adopt that single unidentified placeholder instead of duplicating the call.
  if (existingStateIndex < 0 && toolCallDelta.id) {
    existingStateIndex = findUnidentifiedPlaceholderIndex(
      toolCallStates,
      toolCallDelta,
    );
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
 * 方案.md §7.4: index of the one state that is still missing its identity (`toolCallId === ""`),
 * if this delta is demonstrably that same call.
 *
 * Deliberately conservative — a wrong guess would merge two *different* parallel calls into one
 * and lose an approval row, which is worse than the duplicate it fixes:
 *
 * ```text
 * exactly one unidentified state   (never guess between several)
 * tool name: equal, or unknown on either side
 * arguments: equal prefix (the placeholder is a fragment of this delta)
 * ```
 */
function findUnidentifiedPlaceholderIndex(
  toolCallStates: ToolCallState[],
  toolCallDelta: ToolCallDelta,
): number {
  const unidentified = toolCallStates
    .map((state, index) => ({ state, index }))
    .filter(({ state }) => !state.toolCallId);
  if (unidentified.length !== 1) {
    return -1;
  }

  const { state, index } = unidentified[0];
  const name = toolCallDelta.function?.name ?? "";
  const placeholderName = state.toolCall.function.name ?? "";
  if (placeholderName && name && placeholderName !== name) {
    return -1;
  }
  const args = toolCallDelta.function?.arguments ?? "";
  const placeholderArgs = state.toolCall.function.arguments ?? "";
  if (placeholderArgs && args && !args.startsWith(placeholderArgs)) {
    return -1;
  }
  return index;
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

/**
 * 方案.md §十二 / LazyLoad_merge_provenance_设计.md §2.1:
 * 一个由 `mergeSplitReplies` 合并出来的 GUI item，**尚未以合并后的形状成功落盘**
 * 时，它在磁盘上仍对应多条 raw item。
 *
 * `sourceMessageIds` 是该 merged item 在当前磁盘形状中对应的 raw item
 * identities，按磁盘顺序记录（不是单个 id）。
 *
 * 生命周期（设计 §2.2/§2.3）：只在 GUI runtime 存在；保存时从 wire payload 剥离；
 * 保存成功且该 item 形状未变时由 `clearSavedMergedReplyProvenance` 清除。
 * 清除后该 item 自身 `message.id` 就是磁盘 identity。
 */
export type MergedReplyProvenance = {
  /**
   * 参与该 bubble 的磁盘 source item id，按**磁盘顺序**递归展平。
   *
   * **不去重**：ID 唯一性属于 message identity 的不变量；在 provenance 层静默去重
   * 会掩盖输入里重复 ID 这一更严重的数据问题，并可能改变 `lastSourceMessageId` 语义。
   */
  sourceMessageIds: string[];
  firstSourceMessageId: string;
  /** raw group 磁盘顺序的**最后一项**，不限定 role（可能是 thinking）。 */
  lastSourceMessageId: string;
};

/**
 * 保存快照里每一份 provenance 的指纹（设计 §2.3）。
 *
 * 保存成功之后据此清除 runtime provenance。比较**必须**同时看 id 与有序成员数组 ——
 * id 本身不是"已保存形状"的完整指纹，只比 id 会把任何复用了该 id 的 runtime 状态
 * 当成已落盘。成员不同即视为"不是这次写下去的那条"，保留 provenance（保守方向）。
 */
export type SavedMergedProvenance = {
  /** 保存时该 item 自身的 id（merge 输出 id = 组首 assistant）。 */
  mergedItemMessageId: string;
  /** 保存时该 provenance 的有序成员（调用方负责复制，作为冻结指纹）。 */
  sourceMessageIds: string[];
};

// We need this to handle reorderings (e.g. a mid-array deletion) of the messages array.
// The proper fix is adding a UUID to all chat messages, but this is the temp workaround.
export type ChatHistoryItemWithMessageId = ChatHistoryItem & {
  message: ChatMessage & { id: string };
  /**
   * 只在 GUI runtime 存在（设计 §2）：该 item 由合并而来且尚未按该形状落盘。
   * 不进入 `message`，不发给 Provider，保存前剥离。
   */
  mergedReplyProvenance?: MergedReplyProvenance;
};

/**
 * context 指标快照（用于持久化到 session 文件 / LRU 缓存）。
 * 不含 compiledChatMessages，避免 session 文件体积膨胀和重复持久化文件内容。
 */
/**
 * 正在进行的流式请求的 AbortController 注册表。
 * 切换会话不再 abort 旧流的 controller（旧流转入后台继续跑）；
 * 只有用户主动取消（abortStream / cancelStream）时才统一 abort 所有在跑流。
 */

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
/**
 * 该 item 在磁盘上的成员 id（设计 §2.1）。
 *
 * 已有 provenance 的 item 代表它**上一次**合并的全部原始成员，必须递归展平 ——
 * `prependSessionHistory` 合并的是 `[...新页, ...现有 window]`，而现有 window 里可能
 * 已经有上一轮 merge 出的 item。只取 `item.message.id` 会让第二次 merge 丢掉更早的
 * 成员，`lastSourceMessageId` 随之指错。
 */
function sourceIdsOf(item: ChatHistoryItemWithMessageId): string[] {
  return item.mergedReplyProvenance?.sourceMessageIds ?? [item.message.id];
}

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

    // 设计 §2.1: 按磁盘顺序递归展平组内成员的来源 id（不去重、不限定 role）。
    const sourceMessageIds = group.flatMap(sourceIdsOf);

    // 方案.md §十一: 摘要由持有它的那一条 item 渲染（`ConversationSummary` 读
    // `item.conversationSummary`），而它不一定落在组内第一条 assistant 上
    // （compact 会写到用户点击的那一条）。只继承 `firstAssistant` 会**丢掉**摘要：
    // 真实 SummaryCard 不再渲染，且保存后 Core 的 `latestSummaryOf` 也扫不到它
    // （`core/util/history.ts:648-660`）⇒ 权威响应省略摘要 ⇒ GUI 清掉会话级摘要。
    // 合并 bubble 代表整个组，因此必须携带组内持有的那份摘要。
    //
    // 取组内**最后**一条持有者：Core 的 `latestSummaryOf` 是从尾部倒扫（最后一条
    // 胜出），合并后的 bubble 必须让同一份摘要存活，否则"哪份摘要生效"会变。
    let summaryItem: ChatHistoryItemWithMessageId | undefined;
    for (const member of group) {
      if (member.conversationSummary) {
        summaryItem = member;
      }
    }

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
      // 摘要必须落到 bubble 上（见上）；唯一持有者时与 `...firstAssistant`
      // 的结果相同，多条时按 Core 的"最后一条胜出"覆盖。
      ...(summaryItem
        ? { conversationSummary: summaryItem.conversationSummary }
        : {}),
      // 设计 §2.1/§2.2: 合并后的 item 与磁盘不再同构 ⇒ 记录它代表的 raw 成员。
      mergedReplyProvenance: {
        sourceMessageIds,
        firstSourceMessageId: sourceMessageIds[0],
        lastSourceMessageId: sourceMessageIds[sourceMessageIds.length - 1],
      },
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
 * streamUpdate 的目标对象：总是 `sessionsById[sessionId]` 的 runtime
 * （方案.md §五.10）。无论该 tab 是否可见都写入同一个 runtime —— 没有 LRU
 * 搬运，也没有第二份缓存副本。
 */
export type StreamUpdateTarget = {
  history: ChatHistoryItemWithMessageId[];
  // UI 设置：默认 true=不合并气泡。true 时 thinking 之后的 assistant 内容
  // 保持原有行为（新建条目），false 时才续接前一个 assistant 条目。
  dontMergeReplyBubbles?: boolean;
};

/**
 * 只携带编译元数据的流式消息：由 `BaseLLM.streamChat` 在后端自己编译
 * （`precompiled !== true`）时产出，内容为空，只带**发送载荷**的裁剪/占用信息。
 * 它不是会话内容，因此不写入任何 message/tool 字段。
 *
 * Stage 2E 起它也不再写入任何指标：ContextStatus 的唯一数据源是**完整逻辑会话**指标
 * （`fullConversationMetrics`，由 Core 在保存锁内或 `history/measureConversation` 计量），
 * 而发送载荷指标是请求局部变量（方案.md §五.16.5「不进 Redux」）。识别它仍然必要 ——
 * 这样它不会退化成「一个空的 assistant 帧」而被误判成会话写入（§五.16.4 步骤 2）。
 */
function isCompileMetadataMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content === "" &&
    "metadata" in message &&
    !!message.metadata &&
    ("didPrune" in message.metadata || "contextPercentage" in message.metadata)
  );
}

/**
 * 纯函数版 streamUpdate：把流式消息合并进目标 history。
 * 从原 reducer 提取，保证正常流与后台续流走同一套合并逻辑。
 *
 * 返回值表示**本次调用是否真的写入了会话语义内容**（方案.md §五.16.4 步骤 2）。
 * 判据是「某个分支确实改了目标」，**不是**「这条消息看起来有内容」：
 * 非编译元数据的空 assistant 帧（例如 Anthropic 每轮流结尾的
 * `{role:"assistant", content:"", usage}`）、只剩空白的帧、以及落在同 role 条目上
 * 且没有任何可写字段的 thinking 帧，都不会改动 history，因此必须返回 false，
 * 否则终态提交会在没有产出内容的回合上推进内容版本。
 */
export function applyStreamUpdatesToHistory(
  target: StreamUpdateTarget,
  messages: ChatMessage[],
): boolean {
  if (!target.history.length) {
    return false;
  }
  let wroteConversationContent = false;
  for (const message of messages) {
    // Handle metadata-only messages (yielded by BaseLLM.streamChat when
    // the backend compiles non-precompiled messages). These carry context
    // pruning info so the frontend doesn't need a separate compile request.
    if (isCompileMetadataMessage(message)) {
      // 发送载荷的裁剪/占用信息到此为止：不写 history、不写指标、不 arm 终态提交。
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
      wroteConversationContent = true;
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

        return true;
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
        // A new item changes the saved history even when it starts empty.
        wroteConversationContent = true;
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
        wroteConversationContent = true;
      } else if (
        lastItem.reasoning?.active &&
        messageContent.includes("</think>")
      ) {
        const [reasoningEnd, answerStart] = messageContent.split("</think>");
        lastItem.reasoning.text += reasoningEnd.trimEnd();
        lastItem.reasoning.active = false;
        lastItem.reasoning.endAt = Date.now();
        lastMessage.content += answerStart.trimStart();
        wroteConversationContent = true;
      } else if (lastItem.reasoning?.active) {
        if (
          lastItem.reasoning.text.length > 0 ||
          messageContent.trim().length > 0
        ) {
          lastItem.reasoning.text += messageContent;
          wroteConversationContent = true;
        }
      } else if (
        // Note this only works because new message above
        // was already rendered from parts to string
        lastMessage.content.length > 0 ||
        messageContent.trim().length > 0
      ) {
        lastMessage.content += messageContent;
        wroteConversationContent = true;
      }
    } else if (message.role === "thinking" && message.signature) {
      // Only a real change: a repeated signature frame must not look like output.
      if (
        lastMessage.role === "thinking" &&
        lastMessage.signature !== message.signature
      ) {
        lastMessage.signature = message.signature;
        wroteConversationContent = true;
      }
    } else if (
      message.role === "assistant" &&
      message.toolCalls?.length &&
      lastMessage.role === "assistant"
    ) {
      handleStreamingToolCallUpdates(message, lastItem);
      wroteConversationContent = true;
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
      // The item's persisted metadata changed, so it is a content write.
      wroteConversationContent = true;
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
      wroteConversationContent = true;
    }
  }
  return wroteConversationContent;
}

/**
 * 磁盘首轮条目（方案.md §五.5）：从第一条 user 消息到第二条 user 消息之前
 * （不含），直接来自未经过 GUI bubble merge 的条目序列。与 Core
 * `history.save` 的 `firstTurnItems` 使用同一规则。
 *
 * 懒加载窗口只有尾部时返回空数组 —— 首轮必须来自磁盘头部，不能从尾部猜。
 */
/**
 * 最近一次 compact 的摘要及其来源位置（方案.md §十一），与 Core
 * `latestSummaryOf` 同一规则。用于全量加载时在 GUI 侧恢复权威摘要。
 */
export function latestSummaryOf(
  history: ChatHistoryItemWithMessageId[],
):
  | { sourceMessageId: string; sourceAbsoluteIndex: number; content: string }
  | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const summary = history[i].conversationSummary;
    const messageId = history[i].message.id;
    if (summary && messageId) {
      return {
        sourceMessageId: messageId,
        sourceAbsoluteIndex: i,
        content: summary,
      };
    }
  }
  return undefined;
}

/**
 * 当前回合条目（方案.md §十三.5）：从最新 user message 开始到 history 尾部。
 * tool loop 的每一轮都必须重新调用，不能缓存发送时刻的快照（§十三.6）。
 */
export function getCurrentTurnItems(
  history: ChatHistoryItemWithMessageId[],
): ChatHistoryItemWithMessageId[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].message.role === "user") {
      return history.slice(i);
    }
  }
  return [];
}
