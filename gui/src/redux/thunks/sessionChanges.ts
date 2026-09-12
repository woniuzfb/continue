import { createAsyncThunk } from "@reduxjs/toolkit";
import { MessageModes } from "core";
import { v4 as uuidv4 } from "uuid";
import { selectSessionById } from "../selectors/sessions";
import { setActiveSessionModelProjection } from "../slices/configSlice";
import {
  selectChatModelByRef,
  sessionChatModelRefOf,
} from "../selectors/sessions";
import type { SessionChatModelRef } from "../slices/sessionsSlice";
import {
  deleteTurnByMessageId,
  setSessionChatModelTitle,
  setSessionMode,
  setSessionReasoningEnabled,
  truncateHistoryAfterMessageId,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { enqueueSessionSave } from "./sessionPersistence";
import {
  NO_MEASUREMENT,
  conversationVersionIntent,
} from "../util/sessionSaveIntent";

/**
 * Phase 2 change saves (方案.md §七.2/§七.8).
 *
 * Mode, model and reasoning changes are explicit user choices: they update the
 * target session, project the model to the active UI when it is the visible
 * session, and enqueue the matching save event. A plain projection (tab
 * activation) never saves — see `projectSessionModelToActiveUi`.
 */

export const setSessionModeAndSave = createAsyncThunk<
  void,
  { sessionId: string; mode: MessageModes },
  ThunkApiType
>("sessions/setModeAndSave", async ({ sessionId, mode }, { dispatch }) => {
  dispatch(setSessionMode({ sessionId, mode }));
  // mode 是构造环境，不是内容版本：只保存，由身份比较触发只读重算。
  void dispatch(
    enqueueSessionSave({
      sessionId,
      reason: "MODE_CHANGED",
      measurementIntent: NO_MEASUREMENT,
    }),
  );
});

export const setSessionReasoningAndSave = createAsyncThunk<
  void,
  { sessionId: string; enabled?: boolean },
  ThunkApiType
>(
  "sessions/setReasoningAndSave",
  async ({ sessionId, enabled }, { dispatch }) => {
    // An explicit user toggle (方案.md §七.8): the persisted preference source
    // is what makes the choice survive a config reload.
    dispatch(
      setSessionReasoningEnabled({ sessionId, enabled, source: "explicit" }),
    );
    void dispatch(
      enqueueSessionSave({
        sessionId,
        reason: "REASONING_CHANGED",
        measurementIntent: NO_MEASUREMENT,
      }),
    );
  },
);

/**
 * An explicit user model choice for the chat role. `MODEL_CHANGED` only
 * affects the session that made the choice (方案.md §七.8).
 */
export const setSessionChatModelAndSave = createAsyncThunk<
  void,
  {
    sessionId: string;
    /** Stable identity of the clicked entry; preferred (方案.md §7.5.4). */
    chatModelRef?: SessionChatModelRef;
    /** Legacy/compat entry point, used only when no ref is given. */
    chatModelTitle?: string;
  },
  ThunkApiType
>(
  "sessions/setChatModelAndSave",
  async (
    { sessionId, chatModelRef, chatModelTitle },
    { dispatch, getState },
  ) => {
    const state = getState();
    const models = state.config.config?.modelsByRole?.chat ?? [];
    // 方案.md §7.5.4: resolve by the stable identity when we have one — never by `find(title)`,
    // which silently picks the first of two entries that share a title. A legacy title is honoured
    // only when it is unique.
    const chosen = chatModelRef
      ? selectChatModelByRef(state, chatModelRef)
      : chatModelTitle
        ? (() => {
            const matches = models.filter((m) => m.title === chatModelTitle);
            return matches.length === 1 ? matches[0] : undefined;
          })()
        : undefined;
    if (!chosen) {
      // Unresolvable selection: keep the session's current model — do not write a wrong title, a
      // wrong ref, a projection or a save.
      return;
    }
    dispatch(
      setSessionChatModelTitle({
        sessionId,
        // The resolved entry is the authority for both fields: a caller that passes only a ref must
        // still get the title stored (方案.md §7.5.4).
        chatModelTitle: chosen.title,
        chatModelRef: sessionChatModelRefOf(chosen),
      }),
    );
    if (state.sessions.activeSessionId === sessionId) {
      const model = chosen ?? null;
      dispatch(setActiveSessionModelProjection({ model }));
    }
    void dispatch(
      enqueueSessionSave({
        sessionId,
        reason: "MODEL_CHANGED",
        measurementIntent: NO_MEASUREMENT,
      }),
    );
  },
);

/** Convenience for the visible session (global active-UI entry point). */
export const setActiveSessionModeAndSave = createAsyncThunk<
  void,
  { mode: MessageModes },
  ThunkApiType
>("sessions/setActiveModeAndSave", async ({ mode }, { dispatch, getState }) => {
  const sessionId = getState().sessions.activeSessionId;
  if (!sessionId || !selectSessionById(getState(), sessionId)) {
    return;
  }
  await dispatch(setSessionModeAndSave({ sessionId, mode }));
});

export const setActiveSessionReasoningAndSave = createAsyncThunk<
  void,
  { enabled?: boolean },
  ThunkApiType
>(
  "sessions/setActiveReasoningAndSave",
  async ({ enabled }, { dispatch, getState }) => {
    const sessionId = getState().sessions.activeSessionId;
    if (!sessionId || !selectSessionById(getState(), sessionId)) {
      return;
    }
    await dispatch(setSessionReasoningAndSave({ sessionId, enabled }));
  },
);

/**
 * 方案.md §七.2「内容变更保存」: deleting a turn and trimming the history are
 * user content mutations, so each one is its own save boundary. Both take the
 * target's stable message id — never a window index, which a trim / prepend /
 * bubble merge can invalidate between render and click.
 *
 * Enqueueing after the (synchronous) reducer update means the queued snapshot
 * describes the mutated history.
 */
export const deleteSessionTurn = createAsyncThunk<
  void,
  { sessionId: string; messageId: string },
  ThunkApiType
>(
  "sessions/deleteTurnAndSave",
  async ({ sessionId, messageId }, { dispatch, getState }) => {
    dispatch(deleteTurnByMessageId({ sessionId, messageId }));
    // 删除回合推进了内容版本 ⇒ 这次保存携带计量（revision 取 mutation 之后的值）。
    void dispatch(
      enqueueSessionSave({
        sessionId,
        reason: "TURN_DELETED",
        measurementIntent: conversationVersionIntent(getState(), sessionId),
      }),
    );
  },
);

export const truncateSessionHistoryAfter = createAsyncThunk<
  void,
  { sessionId: string; messageId: string },
  ThunkApiType
>(
  "sessions/truncateHistoryAndSave",
  async ({ sessionId, messageId }, { dispatch, getState }) => {
    // 方案.md §六: new ids are generated in the thunk, never by the reducer —
    // without this the regenerated assistant placeholder would carry an empty
    // id and be unreachable by every byMessageId write.
    dispatch(
      truncateHistoryAfterMessageId({
        sessionId,
        messageId,
        assistantPlaceholderId: uuidv4(),
      }),
    );
    void dispatch(
      enqueueSessionSave({
        sessionId,
        reason: "HISTORY_TRUNCATED",
        measurementIntent: conversationVersionIntent(getState(), sessionId),
      }),
    );
  },
);
