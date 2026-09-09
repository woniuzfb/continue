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
  clearCodeToEdit,
  INITIAL_EDIT_APPLY_STATE,
  setPreviousModeEditorContent,
  setReturnToModeAfterEdit,
  updateEditStateApplyState,
} from "../slices/editState";
import { selectActiveSessionId } from "../selectors/sessionView";
import { createAndActivateSession } from "./sessionActivation";
import {
  beginSessionStream,
  finishSessionStream,
  setSessionIsInEdit,
  setSessionMainEditorContentTrigger,
  setSessionMode,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
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
  const codeToEdit = state.editModeState.codeToEdit;
  const sessionId = selectActiveSessionId(state);
  const isInEdit = sessionId
    ? (state.sessions.sessionsById[sessionId]?.isInEdit ?? false)
    : false;
  const previousModeEditorContent =
    state.editModeState.previousModeEditorContent;

  if (!isInEdit) {
    return;
  }

  if (codeToEdit[0] && state.editModeState.applyState.numDiffs) {
    extra.ideMessenger.post("rejectDiff", {
      filepath: codeToEdit[0].filepath,
    });
  }

  extra.ideMessenger.post("edit/clearDecorations", undefined);

  dispatch(clearCodeToEdit());
  dispatch(updateEditStateApplyState(INITIAL_EDIT_APPLY_STATE));
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
    dispatch(setPreviousModeEditorContent(undefined));
  }

  if (openNewSession || state.editModeState.lastNonEditSessionWasEmpty) {
    await dispatch(createAndActivateSession({ origin: "new" }));
  } else {
    await dispatch(bootstrapLastSession());
  }

  const nextSessionId = selectActiveSessionId(getState());
  if (nextSessionId) {
    dispatch(
      setSessionMode({
        sessionId: nextSessionId,
        mode: state.editModeState.returnToMode,
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

    if (!state.editModeState.codeToEdit[0]) {
      extra.ideMessenger.post("showToast", [
        "info",
        "Please open a file to use Edit mode",
      ]);
      return;
    }

    dispatch(setSessionMainEditorContentTrigger({ sessionId, content: {} }));
    dispatch(setPreviousModeEditorContent(editorContent));

    const currentMode = state.sessions.sessionsById[sessionId]?.mode ?? "chat";
    dispatch(setReturnToModeAfterEdit(returnToMode ?? currentMode));
    dispatch(updateEditStateApplyState(INITIAL_EDIT_APPLY_STATE));

    await dispatch(flushSessionSave({ sessionId }));
    await dispatch(createAndActivateSession({ origin: "new" }));

    const newSessionId = selectActiveSessionId(getState());
    if (newSessionId) {
      dispatch(setSessionIsInEdit({ sessionId: newSessionId, isInEdit: true }));
    }
  },
);
