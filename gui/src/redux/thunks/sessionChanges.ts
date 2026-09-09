import { createAsyncThunk } from "@reduxjs/toolkit";
import { MessageModes } from "core";
import { selectSessionById } from "../selectors/sessions";
import { setActiveSessionModelProjection } from "../slices/configSlice";
import {
  setSessionChatModelTitle,
  setSessionMode,
  setSessionReasoningEnabled,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { enqueueSessionSave } from "./sessionPersistence";

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
  void dispatch(enqueueSessionSave({ sessionId, reason: "MODE_CHANGED" }));
});

export const setSessionReasoningAndSave = createAsyncThunk<
  void,
  { sessionId: string; enabled?: boolean },
  ThunkApiType
>(
  "sessions/setReasoningAndSave",
  async ({ sessionId, enabled }, { dispatch }) => {
    dispatch(setSessionReasoningEnabled({ sessionId, enabled }));
    void dispatch(
      enqueueSessionSave({ sessionId, reason: "REASONING_CHANGED" }),
    );
  },
);

/**
 * An explicit user model choice for the chat role. `MODEL_CHANGED` only
 * affects the session that made the choice (方案.md §七.8).
 */
export const setSessionChatModelAndSave = createAsyncThunk<
  void,
  { sessionId: string; chatModelTitle?: string },
  ThunkApiType
>(
  "sessions/setChatModelAndSave",
  async ({ sessionId, chatModelTitle }, { dispatch, getState }) => {
    dispatch(setSessionChatModelTitle({ sessionId, chatModelTitle }));
    const state = getState();
    if (state.sessions.activeSessionId === sessionId) {
      const models = state.config.config?.modelsByRole?.chat ?? [];
      const model = chatModelTitle
        ? (models.find((m) => m.title === chatModelTitle) ?? null)
        : null;
      dispatch(setActiveSessionModelProjection({ model }));
    }
    void dispatch(enqueueSessionSave({ sessionId, reason: "MODEL_CHANGED" }));
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
