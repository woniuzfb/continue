import { LLMFullCompletionOptions, ModelDescription, Tool } from "core";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { selectSessionActiveTools } from "../selectors/sessionToolCalls";
import type { SessionRuntimeState } from "../slices/sessionsSlice";
import type { RootState } from "../store";
import {
  CONVERSATION_SUMMARY_SEMANTICS_VERSION,
  type FullConversationConstructionInputs,
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
      model: completionOptions.model ?? model.model,
      maxTokens: completionOptions.maxTokens,
      contextLength: model.contextLength,
    },
    conversationSummarySemanticsVersion: CONVERSATION_SUMMARY_SEMANTICS_VERSION,
  };
}
