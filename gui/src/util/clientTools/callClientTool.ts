import { ContextItem, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { selectSessionById } from "../../redux/selectors/sessions";
import { AppThunkDispatch, RootState } from "../../redux/store";
import { normalizeSessionMode } from "../../redux/util/sessionMode";
import { askUserQuestionImpl } from "./askUserQuestionImpl";
import { editToolImpl } from "./editImpl";
import { multiEditImpl } from "./multiEditImpl";
import { singleFindAndReplaceImpl } from "./singleFindAndReplaceImpl";

export interface ClientToolExtras {
  getState: () => RootState;
  dispatch: AppThunkDispatch;
  ideMessenger: IIdeMessenger;
  /**
   * Owning session (方案.md §五.20). Set by the session-scoped tool loop; the
   * legacy active-session path leaves it undefined.
   */
  sessionId?: string;
}

export interface ClientToolOutput {
  output: ContextItem[] | undefined;
  respondImmediately: boolean;
}

export interface ClientToolResult extends ClientToolOutput {
  error?: ContinueError;
}

export type ClientToolImpl = (
  args: any,
  toolCallId: string,
  extras: ClientToolExtras,
) => Promise<ClientToolOutput>;

export async function callClientTool(
  toolCallState: ToolCallState,
  extras: ClientToolExtras,
): Promise<ClientToolResult> {
  const { toolCall, parsedArgs } = toolCallState;
  const state = extras.getState();
  const targetSessionId = extras.sessionId ?? state.sessions.activeSessionId;
  const rawMode = targetSessionId
    ? selectSessionById(state, targetSessionId)?.mode
    : undefined;
  const effectiveMode = rawMode ? normalizeSessionMode(rawMode) : "plan";

  try {
    if (
      effectiveMode === "plan" &&
      (toolCall.function.name === BuiltInToolNames.EditExistingFile ||
        toolCall.function.name === BuiltInToolNames.SingleFindAndReplace ||
        toolCall.function.name === BuiltInToolNames.MultiEdit)
    ) {
      throw new ContinueError(
        ContinueErrorReason.Unspecified,
        `Tool ${toolCall.function.name} is disabled in Plan (read-only) mode.`,
      );
    }

    const resolvedExtras: ClientToolExtras = targetSessionId
      ? { ...extras, sessionId: targetSessionId }
      : extras;
    let output: ClientToolOutput;
    switch (toolCall.function.name) {
      case BuiltInToolNames.EditExistingFile:
        output = await editToolImpl(parsedArgs, toolCall.id, resolvedExtras);
        break;
      case BuiltInToolNames.SingleFindAndReplace:
        output = await singleFindAndReplaceImpl(
          parsedArgs,
          toolCall.id,
          resolvedExtras,
        );
        break;
      case BuiltInToolNames.MultiEdit:
        output = await multiEditImpl(parsedArgs, toolCall.id, resolvedExtras);
        break;
      case BuiltInToolNames.AskUserQuestion:
        output = await askUserQuestionImpl(
          parsedArgs,
          toolCall.id,
          resolvedExtras,
        );
        break;
      default:
        throw new Error(`Invalid client tool name ${toolCall.function.name}`);
    }
    return output;
  } catch (e) {
    return {
      respondImmediately: true,
      error:
        e instanceof ContinueError
          ? e
          : e instanceof Error
            ? new ContinueError(ContinueErrorReason.Unspecified, e.message)
            : new ContinueError(ContinueErrorReason.Unknown, String(e)),
      output: undefined,
    };
  }
}
