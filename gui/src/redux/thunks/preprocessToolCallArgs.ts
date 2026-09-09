import { ToolCallState } from "core";
import { ContinueErrorReason } from "core/util/errors";

import { IIdeMessenger } from "../../context/IdeMessenger";
import { findSessionToolCallTarget } from "../util/sessionToolCallWrites";
import { applySessionToolCallUpdate } from "../util/sessionToolCallWrites";
import {
  errorToolCall,
  setProcessedToolCallArgs,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { AppThunkDispatch, RootState } from "../store";

function invalidArgsContextItem(
  toolCallState: ToolCallState,
  errorMessage: string | undefined,
) {
  return {
    icon: "problems",
    name: "Invalid Tool Call",
    description: "",
    content: `${toolCallState.toolCall.function.name} failed because the arguments were invalid, with the following message: ${errorMessage}\n\nPlease try something else or request further instructions.`,
    hidden: false,
  };
}

/**
 * Phase 1 session-scoped pre-processing (方案.md §五.20).
 *
 * Same request/policy shape as the legacy `preprocessToolCalls`, but the tool
 * call states are read from and written to `sessionsById[sessionId]` — never
 * the active session — through the shared tool-state write path, so
 * `pendingApprovalCount` and the metrics snapshot stay consistent.
 */
export async function preprocessSessionToolCalls(
  api: {
    dispatch: AppThunkDispatch;
    getState: () => RootState;
    ideMessenger: IIdeMessenger;
  },
  input: { sessionId: string; toolCallIds: string[] },
): Promise<void> {
  const { dispatch, getState, ideMessenger } = api;
  const { sessionId, toolCallIds } = input;

  await Promise.all(
    toolCallIds.map(async (toolCallId) => {
      const session = getState().sessions.sessionsById[sessionId];
      const target = session
        ? findSessionToolCallTarget(session.history, toolCallId)
        : undefined;
      if (!target) {
        return;
      }
      const { assistantItem, toolCallState } = target;

      let errorReason: ContinueErrorReason | undefined = undefined;
      let errorMessage: string | undefined = undefined;
      let preprocessedArgs: Record<string, unknown> | undefined = undefined;
      const result = await ideMessenger.request("tools/preprocessArgs", {
        toolName: toolCallState.toolCall.function.name,
        args: toolCallState.parsedArgs,
      });
      if (result.status === "success") {
        preprocessedArgs = result.content.preprocessedArgs;
        errorMessage = result.content.errorMessage;
        errorReason = result.content.errorReason;
      } else {
        errorMessage = result.error;
        errorReason = ContinueErrorReason.Unknown;
      }

      if (errorReason) {
        applySessionToolCallUpdate(api, {
          sessionId,
          messageId: assistantItem.message.id,
          toolCallId,
          patch: {
            status: "errored",
            output: [invalidArgsContextItem(toolCallState, errorMessage)],
          },
        });
      } else if (preprocessedArgs) {
        applySessionToolCallUpdate(api, {
          sessionId,
          messageId: assistantItem.message.id,
          toolCallId,
          patch: { processedArgs: preprocessedArgs },
        });
      }
    }),
  );
}

/** Legacy active-session path; kept until its consumers are migrated. */
export async function preprocessToolCalls(
  dispatch: AppThunkDispatch,
  ideMessenger: IIdeMessenger,
  generatedToolCalls: ToolCallState[],
): Promise<void> {
  // Tool call pre-processing
  await Promise.all(
    generatedToolCalls.map(async (tcState) => {
      let errorReason: ContinueErrorReason | undefined = undefined;
      let errorMessage: string | undefined = undefined;
      let preprocessedArgs: Record<string, unknown> | undefined = undefined;
      const result = await ideMessenger.request("tools/preprocessArgs", {
        toolName: tcState.toolCall.function.name,
        args: tcState.parsedArgs,
      });
      if (result.status === "success") {
        preprocessedArgs = result.content.preprocessedArgs;
        errorMessage = result.content.errorMessage;
        errorReason = result.content.errorReason;
      } else {
        errorMessage = result.error;
        errorReason = ContinueErrorReason.Unknown;
      }
      if (errorReason) {
        dispatch(
          errorToolCall({
            toolCallId: tcState.toolCallId,
          }),
        );
        dispatch(
          updateToolCallOutput({
            toolCallId: tcState.toolCallId,
            contextItems: [invalidArgsContextItem(tcState, errorMessage)],
          }),
        );
      } else if (preprocessedArgs) {
        dispatch(
          setProcessedToolCallArgs({
            toolCallId: tcState.toolCallId,
            newArgs: preprocessedArgs,
          }),
        );
      }
    }),
  );
}
