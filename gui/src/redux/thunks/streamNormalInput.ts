import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ChatMessage, LLMFullCompletionOptions, ModelDescription } from "core";
import { getRuleId } from "core/llm/rules/getSystemMessageWithRules";
import { ToCoreProtocol } from "core/protocol";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import { copyOf } from "core/util";
import { selectActiveTools } from "../selectors/selectActiveTools";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  abortStream,
  addPromptCompletionPair,
  applyStreamUpdatesToHistory,
  CachedSession,
  errorToolCall,
  getCachedSession,
  registerStreamAborter,
  setActive,
  setAppliedRulesAtIndex,
  setContextInputTokens,
  setContextLength,
  setContextMetrics,
  setContextPercentage,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
  setCachedSession,
  setToolGenerated,
  streamUpdate,
  unregisterStreamAborter,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { cacheCurrentSession } from "./session";

import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { interceptSystemToolCalls } from "core/tools/systemMessageTools/interceptSystemToolCalls";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";

import {
  selectCurrentToolCalls,
  selectPendingToolCalls,
} from "../selectors/selectToolCalls";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";
import { callToolById } from "./callToolById";
import { evaluateToolPolicies } from "./evaluateToolPolicies";
import { preprocessToolCalls } from "./preprocessToolCallArgs";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

/**
 * Builds completion options with reasoning configuration based on session state and model capabilities.
 *
 * @param baseOptions - Base completion options to extend
 * @param hasReasoningEnabled - Whether reasoning is enabled in the session
 * @param model - The selected model with provider and completion options
 * @returns Completion options with reasoning configuration
 */
function buildReasoningCompletionOptions(
  baseOptions: LLMFullCompletionOptions,
  hasReasoningEnabled: boolean | undefined,
  model: ModelDescription,
): LLMFullCompletionOptions {
  if (hasReasoningEnabled === undefined) {
    return baseOptions;
  }

  const reasoningOptions: LLMFullCompletionOptions = {
    ...baseOptions,
    reasoning: !!hasReasoningEnabled,
  };

  // Add reasoning budget tokens if reasoning is enabled and provider supports it
  if (hasReasoningEnabled && model.underlyingProviderName !== "ollama") {
    // Ollama doesn't support limiting reasoning tokens at this point
    reasoningOptions.reasoningBudgetTokens =
      model.completionOptions?.reasoningBudgetTokens ?? 2048;
  }

  return reasoningOptions;
}

export const streamNormalInput = createAsyncThunk<
  void,
  {
    legacySlashCommandData?: ToCoreProtocol["llm/streamChat"][0]["legacySlashCommandData"];
    depth?: number;
  },
  ThunkApiType
>(
  "chat/streamNormalInput",
  async (
    { legacySlashCommandData, depth = 0 },
    { dispatch, extra, getState },
  ) => {
    if (process.env.NODE_ENV === "test" && depth > 50) {
      const message = `Max stream depth of ${50} reached in test`;
      console.error(message, JSON.stringify(getState(), null, 2));
      throw new Error(message);
    }

    // Ensure MCP servers are connected before building the tool list, so
    // tools from servers that were briefly down at config-load time are
    // included in this request (they only enter config.tools when the server
    // is "connected" at config load). Only servers the GUI already knows are
    // unhealthy trigger the IPC round trip — healthy ones add zero latency,
    // and the test state (empty statuses) skips it entirely. Bounded
    // server-side; failure to reconnect never blocks sending.
    const mcpStatuses = getState().config.config.mcpServerStatuses ?? [];
    const hasUnhealthyMcp = mcpStatuses.some(
      (s) => s.status !== "connected" && s.status !== "disabled",
    );
    if (hasUnhealthyMcp) {
      try {
        await extra.ideMessenger.request("mcp/ensureConnections", undefined);
      } catch (e) {
        console.warn("Failed to ensure MCP connections before sending", e);
      }
    }

    const state = getState();
    const selectedChatModel = selectSelectedChatModel(state);

    if (!selectedChatModel) {
      throw new Error("No chat model selected");
    }

    // Get tools and apply model-level overrides (disabled, description, etc.)
    let activeTools = selectActiveTools(state);
    if (selectedChatModel.toolOverrides?.length) {
      const { tools: overriddenTools, errors } = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      );
      activeTools = overriddenTools;
      for (const error of errors) {
        if (!error.fatal) {
          console.warn(`Tool override warning: ${error.message}`);
        }
      }
    }

    // Use the centralized selector to determine if system message tools should be used
    const useNativeTools = state.config.config.experimental
      ?.onlyUseSystemMessageTools
      ? false
      : modelSupportsNativeTools(selectedChatModel);
    const systemToolsFramework = !useNativeTools
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;

    // Construct completion options
    let completionOptions: LLMFullCompletionOptions = {};
    if (useNativeTools && activeTools.length > 0) {
      completionOptions = {
        tools: activeTools,
      };
    }

    completionOptions = buildReasoningCompletionOptions(
      completionOptions,
      state.session.hasReasoningEnabled,
      selectedChatModel,
    );

    // Construct messages (excluding system message)
    const baseSystemMessage = state.config.config.ui?.skipBaseSystemMessage
      ? ""
      : getBaseSystemMessage(
          state.session.mode,
          selectedChatModel,
          activeTools,
        );

    const systemMessage = systemToolsFramework
      ? addSystemMessageToolsToSystemMessage(
          systemToolsFramework,
          baseSystemMessage,
          activeTools,
        )
      : baseSystemMessage;

    const withoutMessageIds = state.session.history.map((item) => {
      const { id, ...messageWithoutId } = item.message;
      return { ...item, message: messageWithoutId };
    });

    const { messages, appliedRules, appliedRuleIndex } = constructMessages(
      withoutMessageIds,
      systemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
      systemToolsFramework,
    );

    // TODO parallel tool calls will cause issues with this
    // because there will be multiple tool messages, so which one should have applied rules?
    dispatch(
      setAppliedRulesAtIndex({
        index: appliedRuleIndex,
        appliedRules: appliedRules,
      }),
    );

    dispatch(setActive());
    dispatch(setInlineErrorMessage(undefined));

    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages,
      options: completionOptions,
    });

    if (precompiledRes.status === "error") {
      if (precompiledRes.error.includes("Not enough context")) {
        dispatch(setInlineErrorMessage("out-of-context"));
        dispatch(setInactive());
        return;
      } else {
        throw new Error(precompiledRes.error);
      }
    }

    const {
      compiledChatMessages,
      didPrune,
      contextPercentage,
      inputTokens,
      contextLength,
    } = precompiledRes.content;

    dispatch(setIsPruned(didPrune));
    dispatch(setContextPercentage(contextPercentage));
    if (inputTokens !== undefined) {
      dispatch(setContextInputTokens(inputTokens));
    }
    if (contextLength !== undefined) {
      dispatch(setContextLength(contextLength));
    }
    // 保存指标快照（不含 compiledChatMessages，避免 session 文件膨胀），
    // saveCurrentSession 会持久化到 session 文件，下次加载时直接还原
    dispatch(
      setContextMetrics({
        didPrune,
        contextPercentage,
        inputTokens,
        contextLength,
      }),
    );

    const start = Date.now();
    const streamAborter = state.session.streamAborter;
    // 快照流所属会话：切 tab 后流转入后台继续，更新写入该会话的缓存副本
    const streamSessionId = state.session.id;
    // 保证切走时该会话一定在 LRU 缓存里（后台更新/保存都依赖缓存副本）
    cacheCurrentSession(getState());
    registerStreamAborter(streamAborter);

    // 后台续流工作副本：切走会话后 chunk 写入这里。切换瞬间 loadSession/
    // saveCurrentSession 会重新快照缓存（引用变化），检测到变化才重新克隆，
    // 避免更新写进已被替换的旧对象而丢失。
    let bgCache: CachedSession | undefined;
    const routeToCachedSession = (messages: ChatMessage[]) => {
      const current = getCachedSession(streamSessionId);
      if (!current) {
        return;
      }
      if (bgCache !== current) {
        const copy = copyOf(current);
        copy.dirty = true; // 后台 chunk 属未持久化内容
        bgCache = copy;
        setCachedSession(streamSessionId, copy);
      }
      applyStreamUpdatesToHistory(bgCache!, messages);
    };

    try {
      let gen = extra.ideMessenger.llmStreamChat(
        {
          completionOptions,
          title: selectedChatModel.title,
          messages: compiledChatMessages,
          legacySlashCommandData,
          messageOptions: { precompiled: true },
        },
        streamAborter.signal,
      );
      if (systemToolsFramework && activeTools.length > 0) {
        gen = interceptSystemToolCalls(
          gen,
          streamAborter,
          systemToolsFramework,
        );
      }

      let next = await gen.next();
      while (!next.done) {
        if (streamAborter.signal.aborted) {
          // 用户主动取消（abortStream 会 abort 所有注册中的流）
          break;
        }

        const streamState = getState().session;
        if (streamState.id === streamSessionId && !streamState.isStreaming) {
          // 活动会话的流被显式停止（setInactive）——保持原有 abort 行为。
          // 切走后的会话（后台续流）不受影响。
          dispatch(abortStream());
          break;
        }

        if (streamState.id === streamSessionId) {
          dispatch(streamUpdate(next.value));
        } else {
          // 已切到其他会话：流在后台继续，更新写入该会话的缓存副本
          routeToCachedSession(next.value);
        }
        next = await gen.next();
      }

      // Attach prompt log and end thinking for reasoning models
      if (next.done && next.value) {
        if (getState().session.id === streamSessionId) {
          dispatch(addPromptCompletionPair([next.value]));
        }

        try {
          extra.ideMessenger.post("devdata/log", {
            name: "chatInteraction",
            data: {
              // Runtime logs always carry the full prompt; "" only satisfies
              // the devdata schema at the type level.
              prompt: next.value.prompt ?? "",
              completion: next.value.completion,
              modelProvider: selectedChatModel.underlyingProviderName,
              modelName: selectedChatModel.title,
              modelTitle: selectedChatModel.title,
              sessionId: state.session.id,
              ...(!!activeTools.length && {
                tools: activeTools.map((tool) => tool.function.name),
              }),
              ...(appliedRules.length > 0 && {
                rules: appliedRules.map((rule) => ({
                  id: getRuleId(rule),
                  slug: rule.slug,
                })),
              }),
            },
          });
        } catch (e) {
          console.error("Failed to send dev data interaction log", e);
        }
      }
    } catch (e) {
      const toolCallsToCancel = selectCurrentToolCalls(getState());
      if (
        toolCallsToCancel.length > 0 &&
        e instanceof Error &&
        e.message.toLowerCase().includes("premature close")
      ) {
        for (const tc of toolCallsToCancel) {
          dispatch(
            errorToolCall({
              toolCallId: tc.toolCallId,
              output: [
                {
                  name: "Tool Call Error",
                  description: "Premature Close",
                  content: `"Premature Close" error: this tool call was aborted mid-stream because the arguments took too long to stream or there were network issues. Please re-attempt by breaking the operation into smaller chunks or trying something else`,
                  icon: "problems",
                },
              ],
            }),
          );
        }
      } else {
        throw e;
      }
    }

    // Tool call sequence:
    // 1. Mark generating tool calls as generated
    const state1 = getState();
    if (streamAborter.signal.aborted) {
      unregisterStreamAborter(streamAborter);
      return;
    }
    if (state1.session.id !== streamSessionId || !state1.session.isStreaming) {
      // 会话已切走：跳过工具执行，标记缓存会话结束（后台流完成）
      const cached = getCachedSession(streamSessionId);
      if (cached) {
        setCachedSession(streamSessionId, { ...cached, isStreaming: false });
      }
      unregisterStreamAborter(streamAborter);
      return;
    }
    const originalToolCalls = selectCurrentToolCalls(state1);
    const generatingCalls = originalToolCalls.filter(
      (tc) => tc.status === "generating",
    );
    for (const { toolCallId } of generatingCalls) {
      dispatch(
        setToolGenerated({
          toolCallId,
          tools: state1.config.config.tools,
        }),
      );
    }

    // 2. Pre-process args to catch invalid args before checking policies
    const state2 = getState();
    if (streamAborter.signal.aborted || !state2.session.isStreaming) {
      unregisterStreamAborter(streamAborter);
      return;
    }
    const generatedCalls2 = selectPendingToolCalls(state2);
    await preprocessToolCalls(dispatch, extra.ideMessenger, generatedCalls2);

    // 3. Security check: evaluate updated policies based on args
    const state3 = getState();
    if (streamAborter.signal.aborted || !state3.session.isStreaming) {
      unregisterStreamAborter(streamAborter);
      return;
    }
    const generatedCalls3 = selectPendingToolCalls(state3);
    const toolPolicies = state3.ui.toolSettings;
    const policies = await evaluateToolPolicies(
      dispatch,
      extra.ideMessenger,
      activeTools,
      generatedCalls3,
      toolPolicies,
    );
    const autoApprovedPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithoutPermission",
    );
    const needsApprovalPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithPermission",
    );

    // 4. Execute remaining tool calls
    if (originalToolCalls.length === 0) {
      dispatch(setInactive());
    } else if (needsApprovalPolicies.length > 0) {
      const builtInReadonlyAutoApproved = autoApprovedPolicies.filter(
        ({ toolCallState }) =>
          toolCallState.tool?.group === BUILT_IN_GROUP_NAME &&
          toolCallState.tool?.readonly,
      );

      if (builtInReadonlyAutoApproved.length > 0) {
        const state4 = getState();
        if (streamAborter.signal.aborted || !state4.session.isStreaming) {
          unregisterStreamAborter(streamAborter);
          return;
        }
        await Promise.all(
          builtInReadonlyAutoApproved.map(async ({ toolCallState }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId: toolCallState.toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                }),
              ),
            );
          }),
        );
      }

      dispatch(setInactive());
    } else {
      // auto stream cases increase thunk depth by 1 for debugging
      const state4 = getState();
      const generatedCalls4 = selectPendingToolCalls(state4);
      if (streamAborter.signal.aborted || !state4.session.isStreaming) {
        unregisterStreamAborter(streamAborter);
        return;
      }
      if (generatedCalls4.length > 0) {
        await Promise.all(
          generatedCalls4.map(async ({ toolCallId }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                }),
              ),
            );
          }),
        );
      } else {
        for (const { toolCallId } of originalToolCalls) {
          unwrapResult(
            await dispatch(
              streamResponseAfterToolCall({
                toolCallId,
                depth: depth + 1,
              }),
            ),
          );
        }
      }
    }
  },
);
