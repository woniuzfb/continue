import { createAsyncThunk } from "@reduxjs/toolkit";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  setSessionInterrupted,
  type SessionRuntimeState,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import {
  applySessionToolCallUpdate,
  findSessionToolCallTarget,
} from "../util/sessionToolCallWrites";
import { enqueueSessionSave } from "./sessionPersistence";
import { runSessionStream } from "./sessionStreams";

/**
 * Restart interruption (方案.md §八).
 *
 * After a restart the old request, AbortController, provider stream and tool
 * execution context are gone. A loaded history whose tool calls are still
 * `generating` / `calling` can never be resumed: the user may only Retry (new
 * requestId, old calls superseded) or Dismiss (old calls canceled and saved).
 */

const NON_TERMINAL_TOOL_STATUSES = new Set(["generating", "calling"]);

export function hasUnresumableTurn(
  history: ChatHistoryItemWithMessageId[],
): boolean {
  return history.some((item) =>
    (item.toolCallStates ?? []).some((state) =>
      NON_TERMINAL_TOOL_STATUSES.has(state.status),
    ),
  );
}

/** Stale calls of an interrupted turn are closed as superseded/canceled. */
function cancelStaleToolCalls(
  api: { dispatch: ThunkApiType["dispatch"]; getState: () => any },
  session: SessionRuntimeState,
): void {
  for (const item of session.history) {
    for (const toolCallState of item.toolCallStates ?? []) {
      if (!NON_TERMINAL_TOOL_STATUSES.has(toolCallState.status)) {
        continue;
      }
      const target = findSessionToolCallTarget(
        session.history,
        toolCallState.toolCallId,
      );
      if (!target) {
        continue;
      }
      applySessionToolCallUpdate(api, {
        sessionId: session.id,
        messageId: target.assistantItem.message.id,
        toolCallId: toolCallState.toolCallId,
        patch: { status: "canceled" },
      });
    }
  }
}

/** Dismiss: keep the saved partial and close the stale calls. */
export const dismissInterruptedSession = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/dismissInterrupted",
  async ({ sessionId }, { dispatch, getState }) => {
    const session = selectSessionById(getState(), sessionId);
    if (!session?.interrupted) {
      return;
    }
    cancelStaleToolCalls({ dispatch, getState }, session);
    dispatch(setSessionInterrupted({ sessionId, interrupted: false }));
    await dispatch(enqueueSessionSave({ sessionId, reason: "STREAM_ABORTED" }));
  },
);

/**
 * Retry: supersede the stale calls and start a fresh request on the existing
 * history (new requestId, 方案.md §八).
 */
export const retryInterruptedSession = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/retryInterrupted",
  async ({ sessionId }, { dispatch, getState }) => {
    const session = selectSessionById(getState(), sessionId);
    if (!session?.interrupted) {
      return;
    }
    cancelStaleToolCalls({ dispatch, getState }, session);
    dispatch(setSessionInterrupted({ sessionId, interrupted: false }));
    await dispatch(runSessionStream({ sessionId })).unwrap();
  },
);
