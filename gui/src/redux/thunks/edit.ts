import { createAsyncThunk } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import {
  MessageModes,
  RangeInFileWithContents,
  SetCodeToEditPayload,
} from "core";
import { stripImages } from "core/util/messageContent";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor";

import {
  selectActiveCodeToEdit,
  selectActiveEditApplyState,
  selectActiveLastNonEditSessionWasEmpty,
  selectActivePreviousModeEditorContent,
  selectActiveReturnToMode,
  selectActiveSessionId,
} from "../selectors/sessionView";
import { createAndActivateSession } from "./sessionActivation";
import {
  beginSessionStream,
  finishSessionStream,
  setSessionCodeToEdit,
  setSessionIsInEdit,
  setSessionMainEditorContentTrigger,
  setSessionMode,
  setSessionPreviousModeEditorContent,
  setSessionReturnToMode,
  updateSessionEditApplyState,
} from "../slices/sessionsSlice";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import { ThunkApiType } from "../store";

/** Default per-session edit apply state (方案.md §五.4). */
const INITIAL_EDIT_APPLY_STATE = {
  streamId: EDIT_MODE_STREAM_ID,
  status: "not-started" as const,
};
import { bootstrapLastSession } from "./sessionLifecycle";
import { flushSessionSave } from "./sessionPersistence";
import { sessionStreamWrapper } from "./sessionStreamWrapper";
import { v4 as uuidv4 } from "uuid";

export const streamEditThunk = createAsyncThunk<
  boolean,
  {
    editorState: JSONContent;
    codeToEdit: SetCodeToEditPayload[];
  },
  ThunkApiType
>(
  "edit/streamResponse",
  async ({ editorState, codeToEdit }, { dispatch, extra, getState }) => {
    const sessionId = selectActiveSessionId(getState());
    if (!sessionId) {
      return false;
    }
    const succeeded = await dispatch(
      sessionStreamWrapper({
        sessionId,
        runStream: async () => {
          const requestId = uuidv4();
          dispatch(
            beginSessionStream({
              sessionId,
              requestId,
              aborter: new AbortController(),
            }),
          );

          const { selectedContextItems, content } = await resolveEditorContent({
            sessionId,
            editorState,
            modifiers: {
              noContext: true,
              useCodebase: false,
            },
            ideMessenger: extra.ideMessenger,
            defaultContextProviders: [],
            availableSlashCommands: [],
            dispatch,
            getState,
          });

          const prompt = [
            ...selectedContextItems.map((item) => item.content),
            stripImages(content),
          ].join("\n\n");

          const response = await extra.ideMessenger.request("edit/sendPrompt", {
            prompt,
            range: codeToEdit[0] as RangeInFileWithContents,
          });

          dispatch(
            finishSessionStream({ sessionId, requestId, status: "completed" }),
          );

          if (response.status === "error") {
            throw new Error(response.error);
          }
        },
      }),
    ).unwrap();
    return succeeded;
  },
);

export const exitEdit = createAsyncThunk<
  void,
  { openNewSession?: boolean },
  ThunkApiType
>("edit/exit", async ({ openNewSession }, { dispatch, extra, getState }) => {
  const state = getState();
  const codeToEdit = selectActiveCodeToEdit(state);
  const sessionId = selectActiveSessionId(state);
  const isInEdit = sessionId
    ? (state.sessions.sessionsById[sessionId]?.isInEdit ?? false)
    : false;
  const previousModeEditorContent =
    selectActivePreviousModeEditorContent(state);

  if (!isInEdit) {
    return;
  }

  if (codeToEdit[0] && selectActiveEditApplyState(state)?.numDiffs) {
    extra.ideMessenger.post("rejectDiff", {
      filepath: codeToEdit[0].filepath,
    });
  }

  extra.ideMessenger.post("edit/clearDecorations", undefined);

  dispatch(setSessionCodeToEdit({ sessionId, codeToEdit: [] }));
  dispatch(
    updateSessionEditApplyState({
      sessionId,
      updates: INITIAL_EDIT_APPLY_STATE,
    }),
  );
  if (sessionId) {
    dispatch(setSessionIsInEdit({ sessionId, isInEdit: false }));
  }

  // Restore the previous editor content if available
  if (previousModeEditorContent && sessionId) {
    dispatch(
      setSessionMainEditorContentTrigger({
        sessionId,
        content: previousModeEditorContent,
      }),
    );
    dispatch(
      setSessionPreviousModeEditorContent({ sessionId, content: undefined }),
    );
  }

  if (openNewSession || selectActiveLastNonEditSessionWasEmpty(state)) {
    await dispatch(createAndActivateSession({ origin: "new" }));
  } else {
    await dispatch(bootstrapLastSession());
  }

  const nextSessionId = selectActiveSessionId(getState());
  if (nextSessionId) {
    dispatch(
      setSessionMode({
        sessionId: nextSessionId,
        mode: selectActiveReturnToMode(state),
      }),
    );
  }
});

export const enterEdit = createAsyncThunk<
  void,
  { returnToMode?: MessageModes; editorContent?: JSONContent },
  ThunkApiType
>(
  "edit/enter",
  async ({ returnToMode, editorContent }, { dispatch, extra, getState }) => {
    const state = getState();
    const sessionId = selectActiveSessionId(state);
    const isInEdit = sessionId
      ? (state.sessions.sessionsById[sessionId]?.isInEdit ?? false)
      : false;

    if (isInEdit || !sessionId) {
      return;
    }

    if (!selectActiveCodeToEdit(state)[0]) {
      extra.ideMessenger.post("showToast", [
        "info",
        "Please open a file to use Edit mode",
      ]);
      return;
    }

    dispatch(setSessionMainEditorContentTrigger({ sessionId, content: {} }));
    dispatch(
      setSessionPreviousModeEditorContent({
        sessionId,
        content: editorContent,
      }),
    );

    const currentMode = state.sessions.sessionsById[sessionId]?.mode ?? "chat";
    dispatch(
      setSessionReturnToMode({ sessionId, mode: returnToMode ?? currentMode }),
    );
    dispatch(
      updateSessionEditApplyState({
        sessionId,
        updates: INITIAL_EDIT_APPLY_STATE,
      }),
    );

    await dispatch(flushSessionSave({ sessionId }));
    await dispatch(createAndActivateSession({ origin: "new" }));

    const newSessionId = selectActiveSessionId(getState());
    if (newSessionId) {
      dispatch(setSessionIsInEdit({ sessionId: newSessionId, isInEdit: true }));
    }
  },
);
