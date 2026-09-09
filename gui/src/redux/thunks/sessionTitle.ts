import { createAsyncThunk } from "@reduxjs/toolkit";
import { NEW_SESSION_TITLE } from "core/util/constants";
import {
  selectSessionById,
  selectSessionChatModel,
} from "../selectors/sessions";
import { upsertSessionMetadata } from "../slices/sessionCatalogSlice";
import { markSessionDirty, setSessionTitle } from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { enqueueSessionSave } from "./sessionPersistence";
import { getAssistantResponseText, getChatTitleFromMessage } from "./session";

/**
 * Phase 1 session-scoped title generation (方案.md §七.9).
 *
 * Only a session still titled `NEW_SESSION_TITLE` is described, and only after
 * its turn completed. The description reads the target session's own history —
 * never the active session — and a failure never blocks the reply save.
 */
export const generateSessionTitle = createAsyncThunk<
  string | undefined,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/generateTitle",
  async ({ sessionId }, { dispatch, getState, extra }) => {
    const state = getState();
    const session = selectSessionById(state, sessionId);
    if (!session || session.title !== NEW_SESSION_TITLE) {
      return undefined;
    }

    const selectedChatModel = selectSessionChatModel(state, sessionId);
    let title: string | undefined;

    if (!state.config.config?.disableSessionTitles && selectedChatModel) {
      const assistantResponse = getAssistantResponseText(session.history);
      if (assistantResponse) {
        // Same request-history builder as the send path, so the describer sees
        // the conversation the model actually saw.
        const { messages } = constructMessages(
          session.history,
          undefined,
          [],
          {},
        );
        try {
          const result = await extra.ideMessenger.request(
            "chatDescriber/describe",
            { text: assistantResponse, messages },
          );
          if (result.status === "success" && result.content) {
            title = result.content;
          }
        } catch (e) {
          console.error("Error generating chat title", e);
        }
      }
    }

    // Fallbacks: first user message, then the catalog entry.
    if (!title) {
      const firstMessage = session.history[0]?.message;
      if (firstMessage) {
        title = getChatTitleFromMessage(firstMessage);
      }
    }
    if (!title?.length) {
      const metadata = getState().sessionCatalog.allSessionMetadata.find(
        (entry) => entry.sessionId === sessionId,
      );
      title = metadata?.title;
    }
    if (!title?.length) {
      return undefined;
    }

    dispatch(setSessionTitle({ sessionId, title }));
    dispatch(markSessionDirty({ sessionId }));

    const metadata = getState().sessionCatalog.allSessionMetadata.find(
      (entry) => entry.sessionId === sessionId,
    );
    if (metadata) {
      dispatch(upsertSessionMetadata({ metadata: { ...metadata, title } }));
    }

    // TITLE_CHANGED save boundary.
    await dispatch(enqueueSessionSave({ sessionId, reason: "TITLE_CHANGED" }));
    return title;
  },
);
