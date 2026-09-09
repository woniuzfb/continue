import { createAsyncThunk } from "@reduxjs/toolkit";
import { ApplyState, ApplyToFilePayload, ContextItem } from "core";
import { logAgentModeEditOutcome } from "../../util/editOutcomeLogger";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import { selectSessionById } from "../selectors/sessions";
import {
  resetSessionCodeBlockApplyIndex,
  updateSessionApplyState,
  updateSessionEditApplyState,
} from "../slices/sessionsSlice";
import { AppThunkDispatch, ThunkApiType } from "../store";
import { logToolUsage } from "../util";
import {
  applySessionToolCallUpdate,
  findSessionToolCallTarget,
} from "../util/sessionToolCallWrites";
import { exitEdit } from "./edit";
import { continueToolLoop } from "./sessionTools";

/**
 * Phase 1 session-scoped edit/apply path (方案.md §五.20, §六).
 *
 * `handleApplyStateUpdate` / `applyForEditTool` read and write the active
 * session. These variants take an explicit `sessionId`, so an edit started in
 * tab A finishes in tab A even after the user switched away, and the tool loop
 * continues through `continueToolLoop` instead of the legacy active-session
 * `streamResponseAfterToolCall`.
 *
 * The IDE's applyState event does not carry a sessionId yet (protocol change
 * pending, 方案.md §五.21), so the origin session is recorded per `streamId`
 * when the apply request is issued. Reading the registry is still an explicit
 * lookup — never the active session.
 */

type ApplyOrigin = { sessionId: string; toolCallId: string };

const applyOrigins = new Map<string, ApplyOrigin>();

export function registerApplyOrigin(
  streamId: string,
  origin: ApplyOrigin,
): void {
  applyOrigins.set(streamId, origin);
}

export function lookupApplyOrigin(streamId: string): ApplyOrigin | undefined {
  return applyOrigins.get(streamId);
}

/** Test helper: drop recorded apply origins. */
export function resetApplyOrigins(): void {
  applyOrigins.clear();
}

function editSuccessItem(filepath?: string): ContextItem {
  return {
    name: "Edit Success",
    content: `Successfully edited ${filepath}`,
    description: "",
    hidden: true,
  };
}

function editFailedItem(filepath?: string): ContextItem {
  return {
    name: "Edit Failed",
    content: `Failed to edit ${filepath}. To continue working with the file, read it again to see the most up-to-date contents`,
    description: "",
    hidden: true,
  };
}

function autoFormattingItem(diff: string): ContextItem {
  return {
    icon: "info",
    name: "Auto-formatting Applied",
    description: "Editor auto-formatting changes",
    content: `Along with your edits, the editor applied the following auto-formatting:\n\n${diff}\n\n(Note: Pay close attention to changes such as single quotes being converted to double quotes, semicolons being removed or added, long lines being broken into multiple lines, adjusting indentation style, adding/removing trailing commas, etc. This will help you ensure future SEARCH/REPLACE operations to this file are accurate.)`,
    hidden: false,
  };
}

function applyErrorItem(): ContextItem {
  return {
    icon: "problems",
    name: "Apply Error",
    description: "Failed to apply changes",
    content: `Error editing file: failed to apply changes to file.\n\nPlease try again with correct args or notify the user and request further instructions.`,
    hidden: false,
  };
}

/**
 * Session-scoped apply state update. Also the place where an accepted edit
 * closes its tool call and continues the tool loop.
 */
export const handleSessionApplyStateUpdate = createAsyncThunk<
  void,
  { sessionId: string; applyState: ApplyState },
  ThunkApiType
>(
  "sessions/handleApplyStateUpdate",
  async ({ sessionId, applyState }, { dispatch, getState, extra }) => {
    const api = { dispatch, getState };

    // Edit mode (⌘I) keeps its own apply state on the edit slice: the IDE
    // streams diffs for the inline-edit flow, not for a chat tool call
    // (方案.md §五.20 edit mode).
    if (applyState.streamId === EDIT_MODE_STREAM_ID) {
      dispatch(updateSessionEditApplyState({ sessionId, updates: applyState }));
      if (applyState.status === "closed") {
        const toolCallState = applyState.toolCallId
          ? findSessionToolCallTarget(
              selectSessionById(getState(), sessionId)?.history ?? [],
              applyState.toolCallId,
            )?.toolCallState
          : undefined;
        if (toolCallState) {
          logToolUsage(toolCallState, true, true, extra.ideMessenger);
        }
        void dispatch(exitEdit({}));
      }
      return;
    }

    dispatch(updateSessionApplyState({ sessionId, applyState }));

    const toolCallId = applyState.toolCallId;
    if (!toolCallId) {
      return;
    }
    const target = findSessionToolCallTarget(
      selectSessionById(getState(), sessionId)?.history ?? [],
      toolCallId,
    );
    if (!target) {
      return;
    }
    const { toolCallState } = target;
    const toolName = toolCallState.toolCall.function.name;

    if (
      applyState.status === "done" &&
      getState().ui.toolSettings[toolName] === "allowedWithoutPermission"
    ) {
      extra.ideMessenger.post("acceptDiff", {
        streamId: applyState.streamId,
        filepath: applyState.filepath,
      });
    }

    if (applyState.status !== "closed") {
      return;
    }

    const accepted = toolCallState.status !== "canceled";
    logToolUsage(toolCallState, accepted, true, extra.ideMessenger);

    const session = selectSessionById(getState(), sessionId);
    const resolvedApplyState = session?.codeBlockApplyStates.states.find(
      (candidate) => candidate.streamId === applyState.streamId,
    );
    if (session && resolvedApplyState) {
      void logAgentModeEditOutcome(
        session.history,
        getState().config.config,
        toolCallState,
        resolvedApplyState,
        accepted,
        extra.ideMessenger,
      );
    }

    if (!accepted) {
      return;
    }

    if (toolCallState.status !== "errored") {
      applySessionToolCallUpdate(api, {
        sessionId,
        messageId: target.assistantItem.message.id,
        toolCallId,
        patch: {
          status: "done",
          output: [
            applyState.autoFormattingDiff
              ? autoFormattingItem(applyState.autoFormattingDiff)
              : editSuccessItem(applyState.filepath),
          ],
        },
      });
    } else {
      applySessionToolCallUpdate(api, {
        sessionId,
        messageId: target.assistantItem.message.id,
        toolCallId,
        patch: { output: [editFailedItem(applyState.filepath)] },
      });
    }

    // The turn continues on the same request that produced the edit.
    const requestId = selectSessionById(getState(), sessionId)?.stream
      .requestId;
    if (!requestId) {
      return;
    }
    dispatch(resetSessionCodeBlockApplyIndex({ sessionId }));
    void dispatch(continueToolLoop({ sessionId, requestId, toolCallId }));
  },
);

/** Session-scoped `applyForEditTool`. */
export const applySessionForEditTool = createAsyncThunk<
  void,
  ApplyToFilePayload & { sessionId: string; toolCallId: string },
  ThunkApiType
>("sessions/applyEditTool", async (payload, { dispatch, getState, extra }) => {
  const { sessionId, toolCallId, streamId } = payload;
  registerApplyOrigin(streamId, { sessionId, toolCallId });
  dispatch(
    updateSessionApplyState({
      sessionId,
      applyState: { streamId, toolCallId, status: "not-started" },
    }),
  );

  // The protocol payload must not carry the GUI-only sessionId.
  const { sessionId: _guiSessionId, ...applyPayload } = payload;
  let didError = false;
  try {
    const response = await extra.ideMessenger.request(
      "applyToFile",
      applyPayload,
    );
    if (response.status === "error") {
      didError = true;
    }
  } catch (e) {
    didError = true;
  }
  if (!didError) {
    return;
  }

  const session = selectSessionById(getState(), sessionId);
  const target = session
    ? findSessionToolCallTarget(session.history, toolCallId)
    : undefined;
  const applyState = session?.codeBlockApplyStates.states.findLast(
    (candidate) => candidate.toolCallId === toolCallId,
  );
  if (
    !target ||
    !applyState ||
    applyState.status === "closed" ||
    target.toolCallState.status !== "calling"
  ) {
    return;
  }

  applySessionToolCallUpdate(
    { dispatch, getState },
    {
      sessionId,
      messageId: target.assistantItem.message.id,
      toolCallId,
      patch: { status: "errored", output: [applyErrorItem()] },
    },
  );
  void dispatch(
    handleSessionApplyStateUpdate({
      sessionId,
      applyState: {
        status: "closed",
        streamId: applyState.streamId,
        toolCallId,
      },
    }),
  );
});

/**
 * Single entry point for the client tool implementations: routes to the
 * session-scoped apply path when the caller knows its session, and keeps the
 * legacy active-session path until those consumers are migrated.
 */
export function applyEditToolChanges(
  api: {
    sessionId?: string;
    dispatch: AppThunkDispatch;
    getState?: () => { sessions: { activeSessionId?: string } };
  },
  payload: ApplyToFilePayload & { toolCallId: string },
): void {
  // Apply state lives in exactly one place (方案.md §五.20): the session
  // runtime. Without a runtime there is no owner to write to.
  const sessionId =
    api.sessionId ?? api.getState?.()?.sessions?.activeSessionId ?? undefined;
  if (!sessionId) {
    console.warn(
      "applyEditToolChanges: no session runtime for",
      payload.toolCallId,
    );
    return;
  }
  void api.dispatch(applySessionForEditTool({ ...payload, sessionId }));
}
