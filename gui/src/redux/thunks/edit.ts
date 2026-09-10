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
  selectActiveSessionId,
  selectSessionCodeToEdit,
  selectSessionEditApplyState,
  selectSessionLastNonEditSessionWasEmpty,
  selectSessionPreviousModeEditorContent,
  selectSessionReturnToMode,
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
import { registerEditApplyOrigin } from "../util/applyOrigins";
import { bootstrapLastSession } from "./sessionLifecycle";
import { flushSessionSave } from "./sessionPersistence";
import { sessionStreamWrapper } from "./sessionStreamWrapper";
import { v4 as uuidv4 } from "uuid";

/** Default per-session edit apply state (方案.md §五.4). */
const INITIAL_EDIT_APPLY_STATE = {
  streamId: EDIT_MODE_STREAM_ID,
  status: "not-started" as const,
};

export const streamEditThunk = createAsyncThunk<
  boolean,
  {
    sessionId: string;
    editorState: JSONContent;
    codeToEdit: SetCodeToEditPayload[];
  },
  ThunkApiType
>(
  "edit/streamResponse",
  async (
    { sessionId, editorState, codeToEdit },
    { dispatch, extra, getState },
  ) => {
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

          // 方案.md §五.21: record which session this edit belongs to *before*
          // the request that can start streaming diffs. Edit mode has no tool
          // call, so the origin carries only the session — without it the apply
          // events would have to guess a session (they used to fall back to
          // whichever one was visible).
          registerEditApplyOrigin(EDIT_MODE_STREAM_ID, { sessionId });

          const response = await extra.ideMessenger.request("edit/sendPrompt", {
            prompt,
            range: codeToEdit[0] as RangeInFileWithContents,
            // 方案.md §五.21 P3: edit mode shares one fixed streamId across
            // sessions, so the session has to travel with the request for the
            // IDE to be able to name it on every diff event.
            sessionId,
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
  { sessionId: string; openNewSession?: boolean },
  ThunkApiType
>(
  "edit/exit",
  async ({ sessionId, openNewSession }, { dispatch, extra, getState }) => {
    const state = getState();
    // 方案.md §五.20: the outgoing session is explicit; the session created or
    // bootstrapped below becomes active through the normal activation flow.
    const codeToEdit = selectSessionCodeToEdit(state, sessionId);
    const isInEdit = state.sessions.sessionsById[sessionId]?.isInEdit ?? false;
    const previousModeEditorContent = selectSessionPreviousModeEditorContent(
      state,
      sessionId,
    );

    if (!isInEdit) {
      return;
    }

    if (
      codeToEdit[0] &&
      selectSessionEditApplyState(state, sessionId)?.numDiffs
    ) {
      extra.ideMessenger.post("rejectDiff", {
        filepath: codeToEdit[0].filepath,
        // 方案.md §五.21 P3: the IDE's `closed` answer must name this session.
        sessionId,
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
    dispatch(setSessionIsInEdit({ sessionId, isInEdit: false }));

    // Restore the previous editor content if available
    if (previousModeEditorContent) {
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

    if (
      openNewSession ||
      selectSessionLastNonEditSessionWasEmpty(state, sessionId)
    ) {
      await dispatch(createAndActivateSession({ origin: "new" }));
    } else {
      await dispatch(bootstrapLastSession());
    }

    const nextSessionId = selectActiveSessionId(getState());
    if (nextSessionId) {
      dispatch(
        setSessionMode({
          sessionId: nextSessionId,
          mode: selectSessionReturnToMode(state, sessionId),
        }),
      );
    }
  },
);

export const enterEdit = createAsyncThunk<
  void,
  {
    sessionId: string;
    returnToMode?: MessageModes;
    editorContent?: JSONContent;
  },
  ThunkApiType
>(
  "edit/enter",
  async (
    { sessionId, returnToMode, editorContent },
    { dispatch, extra, getState },
  ) => {
    const state = getState();
    const isInEdit = state.sessions.sessionsById[sessionId]?.isInEdit ?? false;

    if (isInEdit) {
      return;
    }

    if (!selectSessionCodeToEdit(state, sessionId)[0]) {
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
