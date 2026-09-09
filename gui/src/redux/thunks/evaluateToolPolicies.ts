import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool, ToolCallState } from "core";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { isEditTool } from "../../util/toolCallState";
import {
  applySessionToolCallUpdate,
  findSessionToolCallTarget,
} from "../util/sessionToolCallWrites";
import { DEFAULT_TOOL_SETTING, ToolPolicies } from "../slices/uiSlice";
import { AppThunkDispatch, RootState } from "../store";

export interface EvaluatedPolicy {
  policy: ToolPolicy;
  displayValue?: string;
  toolCallState: ToolCallState;
}

/**
 * Evaluates the tool policy for a tool call, including dynamic policy evaluation
 * Note that tool group policies are not considered here because activeTools already excludes disabled groups
 */
async function evaluateToolPolicy(
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  toolCallState: ToolCallState,
  toolPolicies: ToolPolicies,
): Promise<EvaluatedPolicy> {
  // allow edit tool calls without permission
  if (isEditTool(toolCallState.toolCall.function.name)) {
    return { policy: "allowedWithoutPermission", toolCallState };
  }

  const basePolicy =
    toolPolicies[toolCallState.toolCall.function.name] ??
    activeTools.find(
      (tool) => tool.function.name === toolCallState.toolCall.function.name,
    )?.defaultToolPolicy ??
    DEFAULT_TOOL_SETTING;

  const toolName = toolCallState.toolCall.function.name;
  const result = await ideMessenger.request("tools/evaluatePolicy", {
    toolName,
    basePolicy,
    parsedArgs: toolCallState.parsedArgs,
    processedArgs: toolCallState.processedArgs,
  });

  // Evaluate the policy dynamically
  if (result.status === "error") {
    console.error(`Error evaluating tool policy for ${toolName}`, result.error);
    return { policy: "disabled", toolCallState };
  }

  const dynamicPolicy = result.content.policy;
  const displayValue = result.content.displayValue;

  // Ensure dynamic policy cannot be more lenient than base policy
  // Policy hierarchy (most restrictive to least): disabled > allowedWithPermission > allowedWithoutPermission
  if (basePolicy === "disabled") {
    return { policy: "disabled", displayValue, toolCallState }; // Cannot override disabled
  }
  if (
    basePolicy === "allowedWithPermission" &&
    dynamicPolicy === "allowedWithoutPermission"
  ) {
    return { policy: "allowedWithPermission", displayValue, toolCallState }; // Cannot make more lenient
  }

  return { policy: dynamicPolicy, displayValue, toolCallState };
}

function policyViolationContextItem(
  toolCallState: ToolCallState,
  displayValue: string | undefined,
) {
  const command = displayValue || toolCallState.toolCall.function.name;
  return {
    icon: "problems",
    name: "Security Policy Violation",
    description: "Command Disabled",
    content: `This command has been disabled by security policy:\n\n${command}\n\nThis command cannot be executed as it may pose a security risk.`,
    hidden: false,
  };
}

/**
 * Phase 1 session-scoped policy evaluation (方案.md §五.20).
 *
 * Tool call states come from `sessionsById[sessionId]`; disabled calls are
 * marked errored through the shared tool-state write path. The returned
 * policies are what the stream runner splits into auto-approved and
 * needs-approval calls.
 */
export async function evaluateSessionToolPolicies(
  api: {
    dispatch: AppThunkDispatch;
    getState: () => RootState;
    ideMessenger: IIdeMessenger;
  },
  input: {
    sessionId: string;
    toolCallIds: string[];
    activeTools: Tool[];
    toolPolicies: ToolPolicies;
  },
): Promise<EvaluatedPolicy[]> {
  const { ideMessenger } = api;
  const { sessionId, toolCallIds, activeTools, toolPolicies } = input;

  const resolved = toolCallIds
    .map((toolCallId) => {
      const session = api.getState().sessions.sessionsById[sessionId];
      const target = session
        ? findSessionToolCallTarget(session.history, toolCallId)
        : undefined;
      return target ? { target, toolCallId } : undefined;
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  const policyResults = await Promise.all(
    resolved.map(async ({ target, toolCallId }) => {
      const result = await evaluateToolPolicy(
        ideMessenger,
        activeTools,
        target.toolCallState,
        toolPolicies,
      );
      if (result.policy === "disabled") {
        applySessionToolCallUpdate(api, {
          sessionId,
          messageId: target.assistantItem.message.id,
          toolCallId,
          patch: {
            status: "errored",
            output: [
              policyViolationContextItem(
                target.toolCallState,
                result.displayValue,
              ),
            ],
          },
        });
      }
      return result;
    }),
  );

  return policyResults;
}
