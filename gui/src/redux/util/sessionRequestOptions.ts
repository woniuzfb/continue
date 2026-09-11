import type { LLMFullCompletionOptions, ModelDescription, Tool } from "core";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { modelSupportsImages } from "core/llm/autodetect";
import { DEFAULT_MAX_TOKENS } from "core/llm/constants";
// 方案.md §7.1.1：**必须**从 browser-safe 模块导入。`core/llm/countTokens` 是
// Node/Core-only（asyncEncoder → workerpool → worker_threads/os/child_process/path、
// llamaTokenizer、js-tiktoken），从它导入会把整条 Node 依赖链带进 webview bundle。
import { measurementInputsAffectingTokens } from "core/llm/tokenMeasurementInputs";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { getBaseSystemMessage } from "./getBaseSystemMessage";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { selectSessionActiveTools } from "../selectors/sessionToolCalls";
import type { SessionRuntimeState } from "../slices/sessionsSlice";
import type { RootState } from "../store";
import {
  CONVERSATION_SUMMARY_SEMANTICS_VERSION,
  type FullConversationConstructionInputs,
  type FullConversationMeasurementRequest,
} from "core/util/fullConversationMetrics";

/**
 * 方案.md §五.16 / §十三: the context-metrics compile and the real send must
 * build the exact same request, otherwise the displayed context percentage (and
 * the prune decision) describes a different prompt than the one that is sent.
 * These helpers are the single source for tool resolution and completion
 * options; `sessionStreams` (send) and `sessionMetrics` (compile) both use them.
 */

/** Session tools after the model's `toolOverrides` are applied. */
export function resolveSessionActiveTools(
  state: RootState,
  sessionId: string,
  model: ModelDescription,
): Tool[] {
  let activeTools = selectSessionActiveTools(state, sessionId);
  if (model.toolOverrides?.length) {
    const { tools: overriddenTools, errors } = applyToolOverrides(
      activeTools,
      model.toolOverrides,
    );
    activeTools = overriddenTools;
    for (const error of errors) {
      if (!error.fatal) {
        console.warn(`Tool override warning: ${error.message}`);
      }
    }
  }
  return activeTools;
}

export function resolveNativeTooling(
  state: RootState,
  model: ModelDescription,
  activeTools: Tool[],
): {
  useNativeTools: boolean;
  systemToolsFramework?: SystemMessageToolCodeblocksFramework;
} {
  const useNativeTools = state.config.config.experimental
    ?.onlyUseSystemMessageTools
    ? false
    : modelSupportsNativeTools(model);
  return {
    useNativeTools,
    systemToolsFramework: useNativeTools
      ? undefined
      : new SystemMessageToolCodeblocksFramework(),
  };
}

/**
 * Completion options for both the send and the metrics compile: native tools
 * plus the per-session reasoning preference.
 */
export function buildSessionCompletionOptions({
  activeTools,
  useNativeTools,
  hasReasoningEnabled,
  model,
}: {
  activeTools: Tool[];
  useNativeTools: boolean;
  hasReasoningEnabled: boolean | undefined;
  model: ModelDescription;
}): LLMFullCompletionOptions {
  let completionOptions: LLMFullCompletionOptions = {};
  if (useNativeTools && activeTools.length > 0) {
    completionOptions = { tools: activeTools };
  }
  return buildReasoningCompletionOptions(
    completionOptions,
    hasReasoningEnabled,
    model,
  );
}

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
  if (hasReasoningEnabled && model.underlyingProviderName !== "ollama") {
    reasoningOptions.reasoningBudgetTokens =
      model.completionOptions?.reasoningBudgetTokens ?? 2048;
  }
  return reasoningOptions;
}

/**
 * 完整会话构造身份的全部输入（方案.md §五.16.2），由**已经解析好的**请求输入组装 ——
 * 调用方（发送路径与计量路径）本来就必须解析同一批值，这里只做投影，不重新解析、
 * 不读 active session。
 *
 * `systemMessage` 是渲染后的 system message（base system + 生效规则 + system-tools 框架），
 * 因此它已经覆盖 §五.16.2 的 `effectiveRules` / `systemMessage inputs`；这里仍把原始
 * 规则与规则设置一并带入，避免"渲染结果相同但输入不同"被误判为同一身份。
 */
export function buildFullConversationConstructionInputs({
  state,
  session,
  model,
  activeTools,
  completionOptions,
  systemMessage,
}: {
  state: RootState;
  session: SessionRuntimeState;
  model: ModelDescription;
  activeTools: Tool[];
  completionOptions: LLMFullCompletionOptions;
  systemMessage: string;
}): FullConversationConstructionInputs {
  const modelName = completionOptions.model ?? model.model;
  const maxTokens = completionOptions.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    modelIdentity: model.title,
    mode: session.mode,
    reasoningEnabled: session.hasReasoningEnabled,
    effectiveRules: state.config.config.rules ?? [],
    ruleSettings: state.ui.ruleSettings,
    effectiveTools: activeTools,
    systemMessageInputs: systemMessage,
    completionOptionsInputsAffectingMeasurement: {
      // LLMFullCompletionOptions.model 可选；缺失时就是这次请求解析出的模型。
      model: modelName,
      maxTokens: completionOptions.maxTokens,
      contextLength: model.contextLength,
    },
    // 方案.md §7.1.3 (C.3)：只影响 token 计数、不影响消息内容的输入。用 Core 的
    // 同一份投影（`measurementInputsAffectingTokens`），因此派生量（输出预留、
    // 计数安全缓冲）的口径变化也会改变身份 —— 不会出现「公式变了、快照还 fresh」。
    measurementInputs: measurementInputsAffectingTokens({
      modelName,
      knownContextLength: model.contextLength,
      maxTokens,
      supportsImages: modelSupportsImages(
        model.provider,
        model.model,
        model.title,
        model.capabilities,
      ),
      tools: activeTools,
      excludeToolOutputsFromTokenCount: model.excludeToolOutputsFromTokenCount,
      excludeToolOutputsFromTokenCountMinTokens:
        model.excludeToolOutputsFromTokenCountMinTokens,
    }),
    conversationSummarySemanticsVersion: CONVERSATION_SUMMARY_SEMANTICS_VERSION,
  };
}

/**
 * 一条会话的**计量输入**：既用于组装 `history/save` / `history/measureConversation`
 * 的请求，也用于算同一份 `constructionIdentity`。
 *
 * 两者必须来自**同一次解析**，否则请求描述的环境与身份描述的环境可能不是一个东西
 * （那正是「看起来 fresh 的错值」的来源）。
 */
export type SessionMeasurementInputs = {
  request: Omit<
    FullConversationMeasurementRequest,
    "conversationRevision" | "constructionIdentity" | "schemaVersion"
  >;
  identityInputs: FullConversationConstructionInputs;
};

export function resolveSessionMeasurementInputs({
  state,
  session,
  model,
}: {
  state: RootState;
  session: SessionRuntimeState;
  model: ModelDescription;
}): SessionMeasurementInputs {
  const activeTools = resolveSessionActiveTools(state, session.id, model);
  const { useNativeTools, systemToolsFramework } = resolveNativeTooling(
    state,
    model,
    activeTools,
  );
  const completionOptions = buildSessionCompletionOptions({
    activeTools,
    useNativeTools,
    hasReasoningEnabled: session.hasReasoningEnabled,
    model,
  });
  const baseSystemMessage = state.config.config.ui?.skipBaseSystemMessage
    ? ""
    : getBaseSystemMessage(session.mode, model, activeTools);
  const systemMessage = systemToolsFramework
    ? addSystemMessageToolsToSystemMessage(
        systemToolsFramework,
        baseSystemMessage,
        activeTools,
      )
    : baseSystemMessage;

  return {
    request: {
      modelTitle: model.title,
      mode: session.mode,
      systemMessage,
      rules: state.config.config.rules ?? [],
      ruleSettings: state.ui.ruleSettings,
      tools: activeTools,
      reasoning: session.hasReasoningEnabled,
      completionOptions,
      // 注意：**不传** conversationSummaryOverride —— 计量对象是完整逻辑会话，
      // 摘要 carrier 本来就在完整 history 里；override 只服务 Local Provider 的
      // 缩减发送载荷（§十三.0）。
    },
    identityInputs: buildFullConversationConstructionInputs({
      state,
      session,
      model,
      activeTools,
      completionOptions,
      systemMessage,
    }),
  };
}
