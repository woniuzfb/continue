import { createAsyncThunk } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import {
  ChatHistoryItem,
  InputModifiers,
  MessagePart,
  TextMessagePart,
} from "core";
import { v4 as uuidv4 } from "uuid";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { AttachedFile, AttachmentMeta } from "../../components/mainInput/types";
import {
  buildAttachedFilesText,
  extractAttachmentsFromMessage,
} from "../../components/mainInput/util/attachments";
import {
  selectSessionById,
  selectSessionChatModel,
} from "../selectors/sessions";
import {
  markSessionDirty,
  resetSessionCodeBlockApplyIndex,
  setSessionHistory,
  setSessionMainEditorAttachmentsRestore,
  updateHistoryItemByMessageId,
} from "../slices/sessionsSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { ThunkApiType } from "../store";
import { loadFullHistory } from "./sessionPaging";
import { enqueueSessionSave } from "./sessionPersistence";
import { sessionStreamWrapper } from "./sessionStreamWrapper";
import { runSessionStream } from "./sessionStreams";
import { updateSessionFileSymbolsFromFiles } from "./updateFileSymbols";

/**
 * Phase 1 session-scoped send path (方案.md §七.3, §六).
 *
 * The legacy `streamResponseThunk` writes the active session
 * (`submitEditorAndInitAtIndex` / `updateHistoryItemAtIndex`), then runs
 * `streamNormalInput` inside `streamThunkWrapper`. This variant targets an
 * explicit `sessionId`, writes through the sessions slice, and runs
 * `runSessionStream` inside `sessionStreamWrapper`.
 *
 * User submit is an immediate save boundary: the user message and the assistant
 * placeholder are persisted before the request is issued, and the send does not
 * wait for disk.
 */

export type SessionSubmitInput = {
  sessionId: string;
  editorState: JSONContent;
  modifiers: InputModifiers;
  /**
   * Index in the session's *loaded* history to replace (retry / edit-and-resend).
   * Absolute index is computed after the full history is loaded.
   */
  index?: number;
  attachments?: AttachedFile[];
};

function userHistoryItem(
  content: ChatHistoryItemWithMessageId["message"]["content"],
  metadata: AttachmentMeta[],
  editorState: JSONContent,
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id: uuidv4(),
      role: "user",
      content,
      metadata: metadata.length > 0 ? { attachments: metadata } : undefined,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
    editorState,
  };
}

function assistantPlaceholder(): ChatHistoryItemWithMessageId {
  return {
    message: {
      id: uuidv4(),
      role: "assistant",
      content: "",
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

export const submitSessionInput = createAsyncThunk<
  boolean,
  SessionSubmitInput,
  ThunkApiType
>("sessions/submitInput", async (input, { dispatch, getState, extra }) => {
  const { sessionId, editorState, modifiers, index, attachments } = input;
  if (!selectSessionById(getState(), sessionId)) {
    return false;
  }

  return (await dispatch(
    sessionStreamWrapper({
      sessionId,
      runStream: async () => {
        // 1. Lazy-loaded history must be complete before sending, otherwise
        // the model only sees the tail of the conversation.
        const pre = selectSessionById(getState(), sessionId);
        if (!pre) {
          throw new Error("Session no longer exists");
        }
        let indexOffset = 0;
        if (pre.pagination.truncated) {
          indexOffset = pre.pagination.loadedOffset ?? 0;
          await dispatch(loadFullHistory({ sessionId })).unwrap();
        }

        const state = getState();
        const session = selectSessionById(state, sessionId);
        if (!session) {
          throw new Error("Session no longer exists");
        }
        if (!selectSessionChatModel(state, sessionId)) {
          throw new Error("No chat model selected");
        }

        const inputIndex =
          index !== undefined ? index + indexOffset : session.history.length;
        const existingMessage =
          inputIndex >= 0 && inputIndex < session.history.length
            ? session.history[inputIndex].message
            : undefined;
        // A resend does not pass attachments: inherit them from the message
        // being replaced (paths in metadata, contents in <file_content>).
        const filesToAttach =
          attachments ??
          (existingMessage
            ? extractAttachmentsFromMessage(existingMessage)
            : []);
        const attachmentMeta: AttachmentMeta[] = filesToAttach.map((f) => ({
          name: f.name,
          path: f.path,
        }));

        // 2. Structural write: user item + assistant placeholder. Content is
        // filled after resolveEditorContent, mirroring the legacy flow.
        const userItem = userHistoryItem("", attachmentMeta, editorState);
        const nextHistory: ChatHistoryItemWithMessageId[] =
          session.history.length > 0 && inputIndex < session.history.length
            ? [
                ...session.history.slice(0, inputIndex),
                userItem,
                assistantPlaceholder(),
              ]
            : [...session.history, userItem, assistantPlaceholder()];

        dispatch(setSessionHistory({ sessionId, history: nextHistory }));
        dispatch(markSessionDirty({ sessionId }));
        dispatch(
          setSessionMainEditorAttachmentsRestore({
            sessionId,
            attachments: undefined,
          }),
        );
        dispatch(resetSessionCodeBlockApplyIndex({ sessionId }));

        const defaultContextProviders =
          state.config.config.experimental?.defaultContext ?? [];
        const {
          selectedContextItems,
          selectedCode,
          content,
          legacyCommandWithInput,
        } = await resolveEditorContent({
          sessionId,
          editorState,
          modifiers,
          ideMessenger: extra.ideMessenger,
          defaultContextProviders,
          availableSlashCommands: state.config.config.slashCommands,
          dispatch,
          getState,
        });

        const filesForSymbols = [
          ...selectedContextItems
            .filter((item) => item.uri?.type === "file" && item.uri?.value)
            .map((item) => item.uri!.value),
          ...selectedCode.map((rif) => rif.filepath),
        ];
        void dispatch(
          updateSessionFileSymbolsFromFiles({
            sessionId,
            filepaths: filesForSymbols,
          }),
        );

        // 3. Fill the user message: attachments travel as a trailing text
        // part so the echoed bubble stays clean (chips come from metadata).
        let finalContent: ChatHistoryItem["message"]["content"] = content;
        if (filesToAttach.length > 0) {
          const parts: MessagePart[] = Array.isArray(content)
            ? (content as MessagePart[])
            : [{ type: "text", text: content as string } as TextMessagePart];
          parts.push({
            type: "text",
            text: buildAttachedFilesText(filesToAttach),
          });
          finalContent = parts;
        }
        dispatch(
          updateHistoryItemByMessageId({
            sessionId,
            messageId: userItem.message.id,
            updates: {
              message: {
                ...userItem.message,
                content: finalContent,
              } as ChatHistoryItemWithMessageId["message"],
              contextItems: selectedContextItems,
            },
          }),
        );

        // 4. Immediate save boundary (方案.md §七.2/§七.3).
        void dispatch(
          enqueueSessionSave({ sessionId, reason: "USER_SUBMITTED" }),
        );

        // 5. Run the turn.
        await dispatch(
          runSessionStream({
            sessionId,
            legacySlashCommandData: legacyCommandWithInput
              ? {
                  command: legacyCommandWithInput.command,
                  contextItems: selectedContextItems,
                  historyIndex: inputIndex,
                  input: legacyCommandWithInput.input,
                  selectedCode,
                }
              : undefined,
          }),
        ).unwrap();
      },
    }),
  ).unwrap()) as boolean;
});
