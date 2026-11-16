import { ModelDescription, Tool } from "core";
import {
  DEFAULT_AGENT_SYSTEM_MESSAGE,
  DEFAULT_READONLY_SYSTEM_MESSAGE,
} from "core/llm/defaultSystemMessages";

export const NO_TOOL_WARNING =
  "\n\nTHE USER HAS NOT PROVIDED ANY TOOLS, DO NOT ATTEMPT TO USE ANY TOOLS. STOP AND LET THE USER KNOW THAT THERE ARE NO TOOLS AVAILABLE. The user can provide tools by enabling them in the Tool Policies section of the notch (wrench icon)";

export function getBaseSystemMessage(
  messageMode: string,
  model: ModelDescription,
  activeTools?: Tool[],
): string {
  const effectiveMode = messageMode === "chat" ? "plan" : messageMode;
  let baseMessage: string;

  if (effectiveMode === "agent" || effectiveMode === "agent-full") {
    baseMessage = model.baseAgentSystemMessage ?? DEFAULT_AGENT_SYSTEM_MESSAGE;
  } else {
    baseMessage =
      model.basePlanSystemMessage ??
      model.baseChatSystemMessage ??
      DEFAULT_READONLY_SYSTEM_MESSAGE;
  }

  // Add no-tools warning for agent/plan modes when no tools are available
  if (!activeTools || activeTools.length === 0) {
    baseMessage += NO_TOOL_WARNING;
  }

  const dshPolicy =
    effectiveMode === "agent-full"
      ? "\n\nCurrent DSH file policy: danger-full-access.\nApproval prompts are disabled in this session: eligible tool calls execute without interactive confirmation, while tools or commands explicitly disabled by user or security policy remain blocked."
      : effectiveMode === "agent"
        ? "\n\nCurrent DSH file policy: workspace-write."
        : "\n\nCurrent DSH file policy: read-only.";

  return baseMessage + dshPolicy;
}
