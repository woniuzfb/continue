import { createAsyncThunk } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import {
  ChatHistoryItem,
  ContextItemWithId,
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
  clearPendingSubmission,
  commitSubmittedTurn,
  markPendingSubmissionCommitted,
  resetSessionCodeBlockApplyIndex,
  setPendingSubmission,
  setSessionMainEditorAttachmentsRestore,
} from "../slices/sessionsSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import type {
  PendingSubmission,
  SessionRuntimeState,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { resolveHistoryMutationTarget } from "./sessionPaging";
import { enqueueSessionSave } from "./sessionPersistence";
import { NO_MEASUREMENT } from "../util/sessionSaveIntent";
import {
  reportSubmitFailure,
  sessionStreamWrapper,
} from "./sessionStreamWrapper";
import { runSessionStream } from "./sessionStreams";
import { updateSessionFileSymbolsFromFiles } from "./updateFileSymbols";
import { processEditorContent } from "../../components/mainInput/TipTapEditor/utils/processEditorContent";
import { recordSubmitLatency } from "../../util/submitLatency";

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
   * It is interpreted against the window that was visible when it was captured
   * (`capturedOffset + index`), never against the full conversation.
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
  /** Who asked for this send (diagnostic only): a second user item with the same content can
   *  only come from a second submit, so the caller must name its entry point. */
  origin?: "editor" | "error-retry" | "mcp";
};

function userHistoryItem(
  content: ChatHistoryItemWithMessageId["message"]["content"],
  metadata: AttachmentMeta[],
  editorState: JSONContent,
  contextItems: ContextItemWithId[] = [],
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id: uuidv4(),
      role: "user",
      content,
      metadata: metadata.length > 0 ? { attachments: metadata } : undefined,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems,
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

/**
 * Where the draft belongs. Needs no await: a caller-supplied identity is used as is, a
 * window index is resolved against the current window, and no target means append.
 *
 * Returns `undefined` when the caller addressed a turn that is not in the window — the
 * send is about to be refused anyway, so showing a draft would be a lie. (A target that
 * only exists on disk is the same case: the user clicked a bubble that was in the window,
 * so an unresolvable identity here means the window changed underneath.)
 */
function resolveDraftInsertion(
  session: SessionRuntimeState,
  index: number | undefined,
  input: SessionSubmitInput,
): PendingSubmission["insertion"] | undefined {
  if (input.targetMessageId !== undefined) {
    return { kind: "replace", targetMessageId: input.targetMessageId };
  }
  if (index !== undefined) {
    const clicked = session.history[index];
    return clicked
      ? { kind: "replace", targetMessageId: carrierMessageIdOf(clicked) }
      : undefined;
  }
  return { kind: "append" };
}

/** What preparation hands to the retryable stream step. */
type PreparedSubmittedTurn = {
  legacySlashCommandData:
    | {
        command: any;
        contextItems: any;
        historyIndex: number;
        input: string;
        selectedCode: any;
      }
    | undefined;
  insertionKind: "append" | "replace";
};

export const submitSessionInput = createAsyncThunk<
  boolean,
  SessionSubmitInput,
  ThunkApiType
>("sessions/submitInput", async (input, { dispatch, getState, extra }) => {
  const { sessionId, editorState, modifiers, index, attachments, origin } =
    input;
  const startingSession = selectSessionById(getState(), sessionId);
  if (!startingSession) {
    return false;
  }
  // A send already being prepared owns this session: refuse rather than queue a second
  // draft (the UI also disables the input while one is pending).
  if (startingSession.pendingSubmission) {
    return false;
  }

  // ── Show the draft now, synchronously (workflow step 3) ─────────────────────
  //
  // The committed turn cannot exist yet (Stage 2F commits it after context resolution),
  // so this row is the feedback for that wait. `processEditorContent` is synchronous, and
  // the insertion identity is resolvable from the current window, so this costs nothing
  // measurable — and it must stay that way: anything awaited here would reintroduce the
  // delay it is meant to hide.
  const submissionId = uuidv4();
  const draftInsertion = resolveDraftInsertion(startingSession, index, input);
  if (draftInsertion) {
    dispatch(
      setPendingSubmission({
        sessionId,
        submission: {
          submissionId,
          status: "resolving-context",
          insertion: draftInsertion,
          // Same projection the committed bubble renders. Parsing the editor state
          // again here (resolveEditorContent parses it too) is deliberate: reusing its
          // result would mean awaiting it first, which is exactly the delay this draft
          // exists to hide. The parse is synchronous and pure.
          displayContent: processEditorContent(editorState).parts,
          attachmentMeta: attachments?.map((file) => ({
            name: file.name,
            path: file.path,
          })),
          startedAt: Date.now(),
        },
      }),
    );
  }

  // ── Preparation (exactly once) ──────────────────────────────────────────────
  //
  // Workflow "submit latency and retry boundary", step 2: everything from here to the
  // `USER_SUBMITTED` save happens **once per user action**. Only the model stream is
  // retried (see the wrapper call at the end). Letting a retry re-enter this block
  // submitted the same turn twice — measured: two user items, a permanently empty
  // assistant placeholder, `conversationRevision` +3 — and the revision guard cannot stop
  // it, because every attempt re-reads the revision it expects.
  let committedOk = false;
  const prepared = await (async (): Promise<
    PreparedSubmittedTurn | undefined
  > => {
    const submitStartedAt = performance.now();
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

    // Captured from the pre-await snapshot on purpose: the caller's index is
    // relative to the window that was visible when it was passed (方案.md §十二).
    const capturedOffset = pre.pagination.loadedOffset ?? 0;

    // 2. A window holding an unsaved merged bubble is not 1:1 with disk, so its index
    // cannot be converted arithmetically: resolve the captured identity in both arrays — a
    // disk read in the same round trip — and address the **window** coordinate, because the
    // replacement below writes to `session.history`. A miss aborts
    // instead of editing another message.
    //
    // This branch is about *locating the target*, not about completing the request history: a
    // target that was trimmed away cannot be found without reading disk, and the commit needs
    // its position. Completing the request history for the model is a separate concern and is
    // the stream step's read-only snapshot (方案.md §7.2.6) — it never touches this window.
    let resolvedIndex: number | undefined;
    if (
      targetMessageId !== undefined &&
      (windowHasMerge || windowIndex === undefined)
    ) {
      // A merged GUI item or a trimmed-away historical bubble cannot be
      // addressed with offset arithmetic. Hydrate and match the stable ID
      // against disk, then use the post-hydration GUI coordinate.
      const resolveStartedAt = performance.now();
      const resolved = await dispatch(
        resolveHistoryMutationTarget({ sessionId, targetMessageId }),
      ).unwrap();
      recordSubmitLatency({
        phase: "target-resolution",
        sessionId,
        durationMs: performance.now() - resolveStartedAt,
      });
      if (!resolved) {
        throw new Error(
          "Cannot resend: the target message could not be located on disk",
        );
      }
      resolvedIndex = resolved.guiIndex;
    }
    // NOTE: a lazy-loaded window is **not** hydrated on this path at all any more
    // (方案.md §7.2.6). The request does need the complete logical history, but it is
    // obtained by the stream step as a **read-only snapshot**
    // (`resolveRequestHistoryForSend`), so submitting no longer has to replace the
    // visible window with the whole conversation and then watch a save trim it back.
    // `resolveHistoryMutationTarget` above is the one remaining full read here, and it
    // happens only when a target has to be located on disk.

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
    // Stage 2F 收口: everything above was resolved against `session` — the snapshot
    // taken **before** `resolveEditorContent` awaits. The revision is what makes
    // that snapshot's validity checkable again at commit time, and the target is
    // carried as an identity (a number would address another turn by then).
    const expectedConversationRevision = session.conversationRevision;
    // Everything up to here was resolved against the pre-await snapshot: this is the
    // span the user spends without a bubble (context IPC dominates it).
    const insertionKind: "append" | "replace" =
      targetMessageId === undefined ? "append" : "replace";
    const existingMessage =
      inputIndex >= 0 && inputIndex < session.history.length
        ? session.history[inputIndex].message
        : undefined;
    // A resend does not pass attachments: inherit them from the message
    // being replaced (paths in metadata, contents in <file_content>).
    const filesToAttach =
      attachments ??
      (existingMessage ? extractAttachmentsFromMessage(existingMessage) : []);
    const attachmentMeta: AttachmentMeta[] = filesToAttach.map((f) => ({
      name: f.name,
      path: f.path,
    }));

    // 2. Resolve the editor content **first** (方案.md §七.3, Stage 2F): context
    // providers and slash commands are async, and the whole submitted turn —
    // structure + complete user content + context items + attachments — is written
    // by a single action below. Writing the structure before this await used to
    // advance the content revision a second time when the content was filled, and
    // exposed a savable window holding an empty user message.
    //
    // `firstTurnItems` is deliberately untouched: it is the authoritative original
    // first turn persisted for the Local Provider conversation key. Never rebuild it
    // from an edited tail: when the edited bubble is itself the first/only turn,
    // doing so replaces the original key with `new user + empty assistant`. The first
    // edit may appear valid, but the next edit then compiles an almost-empty request
    // and leaves ContextStatus near zero.
    //
    // A brand-new session with no first-turn cache safely uses the full current
    // history; the USER_SUBMITTED save fills the authoritative cache from disk.
    const defaultContextProviders =
      state.config.config.experimental?.defaultContext ?? [];
    // Partition of the pre-bubble wait: this phase + `resolve-editor-content` +
    // `submit-post-editor` should add up to `submit-to-commit`. The partition is what
    // separates "an await of ours is slow" from "the main thread was busy elsewhere".
    recordSubmitLatency({
      phase: "submit-pre-editor",
      sessionId,
      durationMs: performance.now() - submitStartedAt,
      insertion: insertionKind,
    });
    const editorContentStartedAt = performance.now();
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

    recordSubmitLatency({
      phase: "resolve-editor-content",
      sessionId,
      durationMs: performance.now() - editorContentStartedAt,
      insertion: insertionKind,
    });
    recordSubmitLatency({
      phase: "submit-post-editor",
      sessionId,
      durationMs: performance.now() - editorContentStartedAt,
      insertion: insertionKind,
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

    // Attachments travel as a trailing text part so the echoed bubble stays clean
    // (chips come from metadata).
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

    // 3. ONE atomic write for the whole submitted turn (方案.md §五.16.1, Stage 2F):
    // user item with its complete content/context items/attachments, the assistant
    // placeholder, the compaction-summary reindex, exactly one `conversationRevision`
    // advance and one metrics-staleness drop. No state in which the placeholder is
    // visible next to an empty user message ever exists.
    //
    // The reducer validates the target itself (identity + expected revision) and does
    // nothing when it no longer holds — so the success check below is the authority
    // on whether this submit happened at all.
    const resolvedAt = performance.now();
    const submittedUserItem = userHistoryItem(
      finalContent,
      attachmentMeta,
      editorState,
      selectedContextItems,
    );
    dispatch(
      commitSubmittedTurn({
        sessionId,
        userItem: submittedUserItem,
        assistantPlaceholder: assistantPlaceholder(),
        insertion:
          targetMessageId === undefined
            ? { kind: "append", expectedConversationRevision }
            : {
                kind: "replace",
                targetMessageId,
                expectedConversationRevision,
              },
      }),
    );
    // The reducer reports nothing, so "did it commit?" must be answered by the state
    // itself. Membership of the freshly minted user item id is the only **positive**
    // signal: a revision comparison would be fooled by an unrelated bump that happens
    // to land on the same number.
    recordSubmitLatency({
      phase: "commit-turn",
      sessionId,
      durationMs: performance.now() - resolvedAt,
      insertion: insertionKind,
      hadContext: selectedContextItems.length > 0,
      // Origin + wall clock: two sends of the same content are then two lines with their entry
      // point and their time difference (方案.md §7.4).
      reason: `origin=${origin ?? "editor"}`,
      at: Date.now(),
      ok: true,
    });
    recordSubmitLatency({
      phase: "submit-to-commit",
      sessionId,
      durationMs: performance.now() - submitStartedAt,
      insertion: insertionKind,
      hadContext: selectedContextItems.length > 0,
    });
    const afterCommit = selectSessionById(getState(), sessionId);
    const committed =
      !!afterCommit &&
      afterCommit.history.some(
        (item) => item.message.id === submittedUserItem.message.id,
      );
    if (!committed) {
      // Either the conversation moved on while the content was being resolved (the
      // target would have been stale) or the target message is gone. Either way: no
      // save, no request — a stale submit must not rewrite another turn, and it must
      // not silently become an append.
      if (!afterCommit) {
        throw new Error("Session no longer exists");
      }
      throw new Error(
        afterCommit.conversationRevision !== expectedConversationRevision
          ? "Cannot send: the conversation changed while the message was being prepared"
          : "Cannot resend: the target message is no longer in the loaded history",
      );
    }
    // The draft row is done (the real bubble is committed), but the *presentation* state is
    // not: until `beginSessionStream` runs, `isStreaming` is false and the bubble would fall
    // back to the static history border for the whole save window (~230ms measured). Marking
    // it committed keeps the animated border on that exact message and stops the second row
    // from rendering.
    committedOk = true;
    dispatch(
      markPendingSubmissionCommitted({
        sessionId,
        submissionId,
        committedUserMessageId: submittedUserItem.message.id,
      }),
    );
    dispatch(
      setSessionMainEditorAttachmentsRestore({
        sessionId,
        attachments: undefined,
      }),
    );
    dispatch(resetSessionCodeBlockApplyIndex({ sessionId }));

    // 4. Immediate save boundary (方案.md §七.2/§七.3).
    const beforeSaveEnqueue = performance.now();
    void dispatch(
      enqueueSessionSave({
        sessionId,
        reason: "USER_SUBMITTED",
        // 方案.md §五.16.4：这里只有 user + **空** assistant placeholder，
        // 不是权威的完整会话指标；保留 last-known（stale），由 terminal save 形成
        // 新的 fresh 指标。
        measurementIntent: NO_MEASUREMENT,
      }),
    );

    recordSubmitLatency({
      phase: "save-enqueue",
      sessionId,
      durationMs: performance.now() - beforeSaveEnqueue,
      insertion: insertionKind,
    });

    return {
      legacySlashCommandData: legacyCommandWithInput
        ? {
            command: legacyCommandWithInput.command,
            contextItems: selectedContextItems,
            historyIndex: inputIndex,
            input: legacyCommandWithInput.input,
            selectedCode,
          }
        : undefined,
      insertionKind,
    };
  })()
    .catch((error) => {
      // Same user-visible outcome as before this split: a dialog explaining the failure,
      // and a `false` result for the send. Never a rejected promise — callers `unwrap()`.
      reportSubmitFailure({ dispatch, getState }, sessionId, error);
      return undefined;
    })
    .finally(() => {
      // Failure paths clear the draft (resolution error, stale target, session gone). The
      // success path already moved it to `committed-awaiting-stream`, which this must not
      // undo — the awaiting-stream border has to survive until the stream begins. ID-checked,
      // so a slow failing attempt cannot clear a newer draft.
      if (!committedOk) {
        dispatch(clearPendingSubmission({ sessionId, submissionId }));
      }
    });
  if (!prepared) {
    return false;
  }
  const preparedAt = performance.now();

  // ── The retryable unit: only the model stream ───────────────────────────────
  //
  // `sessionStreamWrapper` retries this closure on transient / overloaded failures. It
  // must contain nothing that writes the submitted turn: that turn is already committed,
  // saved and visible, so re-running it duplicates it.
  return (await dispatch(
    sessionStreamWrapper({
      sessionId,
      runStream: async () => {
        // Recorded per **attempt**: with a retry this appears twice, which is exactly the
        // evidence that the retry stayed inside the stream step. The duration is the wait
        // since preparation finished (dispatch overhead, plus the backoff on a retry).
        recordSubmitLatency({
          phase: "stream-start",
          sessionId,
          durationMs: performance.now() - preparedAt,
          insertion: prepared.insertionKind,
        });
        await dispatch(
          runSessionStream({
            sessionId,
            legacySlashCommandData: prepared.legacySlashCommandData,
          }),
        ).unwrap();
      },
    }),
  ).unwrap()) as boolean;
});
