import { LLMFullCompletionOptions, ModelDescription, Tool } from "core";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { selectSessionActiveTools } from "../selectors/sessionToolCalls";
import type { RootState } from "../store";

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
