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
import { windowToAbsoluteIndex } from "../util/historyIndex";
import {
  carrierMessageIdOf,
  findGuiIndexContainingMessageId,
  windowHasUnsavedMerge,
} from "../util/historyTarget";
import {
  markSessionDirty,
  resetSessionCodeBlockApplyIndex,
  clearSessionConversationSummary,
  setSessionHistory,
  setSessionMainEditorAttachmentsRestore,
  setSessionConversationSummary,
  updateHistoryItemByMessageId,
} from "../slices/sessionsSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { ThunkApiType } from "../store";
import { loadFullHistory, resolveHistoryMutationTarget } from "./sessionPaging";
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
   *
   * Prefer `targetMessageId` where the caller knows it: a window index is only
   * meaningful against the array it was read from, and a bubble's index moves
   * as the window is trimmed or fully hydrated.
   */
  index?: number;
  /**
   * Identity of the message to replace. Preferred over `index`.
   *
   * An inline history editor resolves its `onEnter` once, when the bubble
   * mounts, so a positional `index` captured there goes stale the moment the
   * window changes underneath it (a post-save trim, a full hydration): the next
   * edit then addresses the wrong row or aborts with "no longer in the loaded
   * history". The message id is stable across all of those, so the target is
   * re-resolved in the **current** window at send time.
   */
  targetMessageId?: string;
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
        // 1. Capture the target identity *before* any await (方案.md §十二): the
        // caller's index is relative to the window that was on screen, and both a
        // full load (which replaces `session.history`) and a trim moving
        // `loadedOffset` invalidate that index. The identity survives both.
        const pre = selectSessionById(getState(), sessionId);
        if (!pre) {
          throw new Error("Session no longer exists");
        }
        const windowHasMerge = windowHasUnsavedMerge(pre.history);
        let targetMessageId: string | undefined;
        // The window index used for the arithmetic below. `index` is used
        // verbatim only when the caller did not supply an identity.
        let windowIndex = index;
        if (input.targetMessageId !== undefined) {
          // Identity wins: re-resolve the target's position in the window **now**.
          // If lazy loading has trimmed the bubble, resolve the identity against
          // disk below rather than rejecting a real historical message.
          const found = findGuiIndexContainingMessageId(
            pre.history,
            input.targetMessageId,
          );
          windowIndex = found >= 0 ? found : undefined;
          targetMessageId = input.targetMessageId;
          if (found < 0 && !pre.pagination.truncated) {
            throw new Error(
              "Cannot resend: the target message is no longer in the loaded history",
            );
          }
        } else if (index !== undefined) {
          const clicked = pre.history[index];
          targetMessageId = clicked ? carrierMessageIdOf(clicked) : undefined;
          if (targetMessageId === undefined) {
            throw new Error(
              "Cannot resend: the target message is no longer in the loaded history",
            );
          }
        }

        // Captured from the pre-await snapshot on purpose: `loadFullHistory`
        // resets `loadedOffset` to 0, but the caller's index is relative to the
        // window that was visible when it was passed (方案.md §十二).
        const capturedOffset = pre.pagination.loadedOffset ?? 0;

        // 2. Lazy-loaded history must be complete before sending, otherwise the
        // model only sees the tail of the conversation.
        //
        // A window holding an unsaved merged bubble is not 1:1 with disk, so its
        // index cannot be converted arithmetically: resolve the captured identity
        // in both arrays — which hydrates the window in the same round trip — and
        // address the **window** coordinate, because the replacement below writes
        // to `session.history`. A miss aborts instead of editing another message.
        let resolvedIndex: number | undefined;
        if (
          targetMessageId !== undefined &&
          (windowHasMerge || windowIndex === undefined)
        ) {
          // A merged GUI item or a trimmed-away historical bubble cannot be
          // addressed with offset arithmetic. Hydrate and match the stable ID
          // against disk, then use the post-hydration GUI coordinate.
          const resolved = await dispatch(
            resolveHistoryMutationTarget({ sessionId, targetMessageId }),
          ).unwrap();
          if (!resolved) {
            throw new Error(
              "Cannot resend: the target message could not be located on disk",
            );
          }
          resolvedIndex = resolved.guiIndex;
        } else if (pre.pagination.truncated) {
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
          resolvedIndex !== undefined
            ? resolvedIndex
            : windowIndex !== undefined
              ? windowToAbsoluteIndex(capturedOffset, windowIndex)
              : session.history.length;
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
        // `firstTurnItems` is the authoritative original first turn persisted
        // for the Local Provider conversation key. Never rebuild it from an
        // edited tail: when the edited bubble is itself the first/only turn,
        // doing so replaces the original key with `new user + empty assistant`.
        // The first edit may appear valid, but the next edit then compiles an
        // almost-empty request and leaves ContextStatus near zero.
        //
        // A brand-new session with no first-turn cache safely uses the full
        // current history; the USER_SUBMITTED save fills the authoritative
        // cache from disk.
        const oldSummary = session.latestConversationSummary;
        const retainedSummaryIndex = oldSummary
          ? nextHistory.findIndex(
              (item) =>
                item.message.id === oldSummary.sourceMessageId &&
                item.conversationSummary === oldSummary.content,
            )
          : -1;
        if (oldSummary && retainedSummaryIndex < 0) {
          dispatch(clearSessionConversationSummary({ sessionId }));
        } else if (oldSummary && retainedSummaryIndex >= 0) {
          dispatch(
            setSessionConversationSummary({
              sessionId,
              summary: {
                ...oldSummary,
                sourceAbsoluteIndex: retainedSummaryIndex,
              },
            }),
          );
        }
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
