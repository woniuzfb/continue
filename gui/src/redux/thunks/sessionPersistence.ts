import { createAsyncThunk } from "@reduxjs/toolkit";
import { Session } from "core";
import { selectSessionById } from "../selectors/sessions";
import { ensureMessageIds } from "../util/messageIds";
import { upsertSessionMetadata } from "../slices/sessionCatalogSlice";
import type {
  ChatHistoryItemWithMessageId,
  SavedMergedProvenance,
} from "../slices/sessionHistory";
import {
  markSessionPersisted,
  markSessionSaveFailed,
  markSessionSaving,
  clearSavedMergedReplyProvenance,
  clearSessionConversationSummary,
  setSessionConversationSummary,
  setSessionFirstTurn,
  setSessionPagination,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { reconcilePaginationAfterPersist } from "./sessionPaging";
import { releaseClosingSessionIfClean } from "./sessionLifecycle";

/**
 * Phase 1/2 save path (方案.md §五.10/§七.5).
 *
 * The snapshot always comes from `sessionsById[sessionId]` — never from the
 * active session, the LRU cache or the current tab. One in-flight save per
 * session; newer requests coalesce into the latest snapshot while keeping the
 * "user submitted" and "stream terminal" boundaries as the last write.
 */

type SaveReason = string;

type PendingSave = {
  revision: number;
  reason: SaveReason;
};

const pendingSaves = new Map<string, PendingSave>();
const runningSaves = new Map<string, Promise<void>>();

/**
 * GUI runtime → wire (设计 §3.2): `Session.history` is a protocol field, while
 * `mergedReplyProvenance` is runtime-only bookkeeping.
 *
 * Creates **new** item objects and never mutates the runtime ones — the runtime
 * provenance must survive a failed save intact (设计 §2.3). It also freezes the
 * fingerprints of everything it stripped, so a successful save can drop exactly
 * the provenance that was written.
 */
function stripHistoryRuntimeFields(history: ChatHistoryItemWithMessageId[]): {
  wireHistory: ChatHistoryItemWithMessageId[];
  savedMergedProvenance: SavedMergedProvenance[];
} {
  const savedMergedProvenance: SavedMergedProvenance[] = [];
  const wireHistory = history.map((item) => {
    const { mergedReplyProvenance, ...wireItem } = item;
    if (mergedReplyProvenance) {
      savedMergedProvenance.push({
        mergedItemMessageId: item.message.id,
        // Copied on purpose: this is a frozen fingerprint, it must not share an
        // array with the runtime provenance it describes.
        sourceMessageIds: [...mergedReplyProvenance.sourceMessageIds],
      });
    }
    return wireItem as ChatHistoryItemWithMessageId;
  });
  return { wireHistory, savedMergedProvenance };
}

function buildSessionPayload(
  sessionId: string,
  getState: () => any,
):
  | {
      payload: Session;
      savedMergedProvenance: SavedMergedProvenance[];
    }
  | undefined {
  const state = getState();
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return undefined;
  }
  const { wireHistory, savedMergedProvenance } = stripHistoryRuntimeFields(
    session.history,
  );
  const payload = {
    sessionId,
    title: session.title,
    workspaceDirectory: window.workspacePaths?.[0] || "",
    history: wireHistory,
    mode: session.mode,
    chatModelTitle: session.chatModelTitle ?? null,
    // 懒加载合并保存：把分页标记传给后端，save 时保留未加载的头部。
    historyTruncated: session.pagination.truncated,
    historyLoadedOffset: session.pagination.loadedOffset,
    contextMetrics: session.contextMetrics,
    // 方案.md §七.8: the reasoning preference is per-session state and must
    // round-trip through history/save, otherwise a reload silently reverts to
    // the derived default.
    hasReasoningEnabled: session.hasReasoningEnabled,
    reasoningPreferenceSource: session.reasoningPreferenceSource,
  } as Session;
  return { payload, savedMergedProvenance };
}

async function performSave(
  sessionId: string,
  request: PendingSave,
  { dispatch, getState, extra }: any,
): Promise<void> {
  const built = buildSessionPayload(sessionId, getState);
  if (!built) {
    return;
  }
  const { payload, savedMergedProvenance } = built;

  // Incremental updates only: a snapshot taken here would roll back any
  // revision bumped by a chunk / tool result arriving during the request
  // (方案.md §七.5).
  dispatch(markSessionSaving({ sessionId }));

  const result = await extra.ideMessenger.request("history/save", payload);

  if (result.status === "error") {
    dispatch(
      markSessionSaveFailed({
        sessionId,
        error: {
          code: result.errorCode ?? "SESSION_SAVE_FAILED",
          message: result.error,
        },
      }),
    );
    // Never clear dirty / pending on failure (方案.md §七.7).
    throw new Error(result.error);
  }

  // 设计 §2.3/§0.4: the save succeeded, so everything in `payload.history` is now
  // on disk in exactly the shape it was sent — regardless of whether the response
  // is still the current revision. Drop the provenance that was just persisted,
  // so a merged item falls back to its own id as the disk identity.
  //
  // This must sit **before** the `responseIsCurrent` gate: a save in flight can
  // see ordinary content changes (a new user message, a stream chunk) that bump
  // `persistence.revision` while leaving this merged item untouched. Its
  // provenance is still stale-on-disk and must be cleared. The reducer is the
  // actual guard — it only drops items whose id *and* ordered members still
  // match the saved fingerprint, so provenance produced by a concurrent
  // prepend+merge (revision unchanged, members changed) survives.
  if (savedMergedProvenance.length > 0) {
    dispatch(
      clearSavedMergedReplyProvenance({ sessionId, savedMergedProvenance }),
    );
  }

  // 方案.md §七.8.1: the response carries the authoritative post-merge data for
  // the snapshot that was sent. If the session changed while the save was in
  // flight (`persistence.revision` moved on), the response describes older
  // content: its disk-derived metadata must not overwrite the newer runtime
  // state. The save itself still counts as persisted at its own revision.
  //
  // Only these session-wide authority fields are revision-gated; the provenance
  // clear above is deliberately not (设计 §0.4).
  const current = selectSessionById(getState(), sessionId);
  const responseIsCurrent =
    current !== undefined && current.persistence?.revision === request.revision;

  if (responseIsCurrent && result.content?.totalHistoryCount !== undefined) {
    dispatch(
      setSessionPagination({
        sessionId,
        pagination: { totalCount: result.content.totalHistoryCount },
      }),
    );
  }
  // The response is authoritative: an empty first turn must *clear* the old
  // one, otherwise a deleted/emptied session keeps serving a stale first turn
  // (方案.md §五.5).
  if (responseIsCurrent && result.content?.firstTurnItems !== undefined) {
    dispatch(
      setSessionFirstTurn({
        sessionId,
        firstTurnItems: ensureMessageIds(result.content.firstTurnItems),
      }),
    );
  }
  // Same authority for the summary: deleting a compaction makes the disk
  // response omit it, and a leftover summary would keep feeding
  // `conversationSummaryOverride` to the Local Provider (方案.md §七.8.1).
  const summary = result.content?.latestConversationSummary;
  if (responseIsCurrent && summary?.sourceMessageId && summary.content) {
    dispatch(
      setSessionConversationSummary({
        sessionId,
        summary: {
          sourceMessageId: summary.sourceMessageId,
          sourceAbsoluteIndex: summary.sourceAbsoluteIndex,
          content: summary.content,
        },
      }),
    );
  } else if (responseIsCurrent) {
    dispatch(clearSessionConversationSummary({ sessionId }));
  }

  // 方案.md §五.6 / §七.8.1: the catalog mirrors the disk, and **this save is what
  // writes the session into `sessions.json`** — Core already built that entry and
  // handed it back. Without this, a brand-new session stays invisible in View
  // History (the History page renders Redux only, and `sessionTitle` can only
  // update an entry that already exists), until a reload re-runs `history/list`.
  //
  // No `history/list` here: one upsert per save, never a full catalog rebuild.
  const savedMetadata = result.content?.sessionMetadata;
  if (savedMetadata && savedMetadata.sessionId === sessionId) {
    const known = getState().sessionCatalog.allSessionMetadata.some(
      (entry: { sessionId: string }) => entry.sessionId === sessionId,
    );
    // Insert whenever the entry is missing — the save just proved it exists on
    // disk, and that fact is independent of the revision gate (like the
    // provenance clear above). Refresh the mutable fields (title /
    // messageCount / workspace) only from a response that still describes the
    // current revision: a stale response describes older content, and letting it
    // win would roll the catalog back. Saves for one session are serialized by
    // the per-session save loop, so a newer response can never be overtaken by
    // an older one.
    if (!known || responseIsCurrent) {
      dispatch(upsertSessionMetadata({ metadata: savedMetadata }));
    }
  }

  dispatch(
    markSessionPersisted({
      sessionId,
      revision: request.revision,
      hasPersistedBaseline: true,
    }),
  );
  // 方案.md §九.7: the saved window is now on disk, so the frozen head can be
  // released. The thunk re-checks every gate (revision, clean, idle, no
  // approval, 1:1 GUI/disk mapping) and only uses the response's authoritative
  // disk count — it never derives the mapping from the visible window.
  void dispatch(
    reconcilePaginationAfterPersist({
      sessionId,
      savedRevision: request.revision,
      totalHistoryCount: responseIsCurrent
        ? result.content?.totalHistoryCount
        : undefined,
    }),
  );
  // A hidden owner that is now clean can be released (方案.md §八).
  void dispatch(releaseClosingSessionIfClean({ sessionId }));
}

function startSaveLoop(sessionId: string, thunkApi: any): Promise<void> {
  const run = (async () => {
    try {
      while (pendingSaves.has(sessionId)) {
        const request = pendingSaves.get(sessionId)!;
        pendingSaves.delete(sessionId);
        await performSave(sessionId, request, thunkApi);
      }
    } finally {
      runningSaves.delete(sessionId);
    }
  })();
  runningSaves.set(sessionId, run);
  return run;
}

export const saveSession = createAsyncThunk<
  void,
  { sessionId: string; reason: SaveReason },
  ThunkApiType
>("sessions/save", async ({ sessionId, reason }, thunkApi) => {
  const session = selectSessionById(thunkApi.getState(), sessionId);
  if (!session) {
    return;
  }
  pendingSaves.set(sessionId, {
    revision: session.persistence?.revision ?? 0,
    reason,
  });
  const running = runningSaves.get(sessionId);
  await (running ?? startSaveLoop(sessionId, thunkApi));
});

/** Explicit enqueue alias used by event-driven saves. */
export const enqueueSessionSave = saveSession;

export const flushSessionSave = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>("sessions/flushSave", async ({ sessionId }, thunkApi) => {
  const session = selectSessionById(thunkApi.getState(), sessionId);
  if (!session) {
    return;
  }
  pendingSaves.set(sessionId, {
    revision: session.persistence?.revision ?? 0,
    reason: "flush",
  });
  const running = runningSaves.get(sessionId);
  await (running ?? startSaveLoop(sessionId, thunkApi));
});

export const flushAllPendingSessions = createAsyncThunk<
  void,
  void,
  ThunkApiType
>("sessions/flushAll", async (_, thunkApi) => {
  const ids = new Set([
    ...runningSaves.keys(),
    ...pendingSaves.keys(),
    ...Object.keys(thunkApi.getState().sessions.sessionsById),
  ]);
  await Promise.all(
    [...ids].map(async (sessionId) => {
      const session = selectSessionById(thunkApi.getState(), sessionId);
      if (!session?.dirty) {
        return;
      }
      pendingSaves.set(sessionId, {
        revision: session.persistence?.revision ?? 0,
        reason: "flush-all",
      });
      await (runningSaves.get(sessionId) ?? startSaveLoop(sessionId, thunkApi));
    }),
  );
});

export const retrySessionSave = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>("sessions/retrySave", async ({ sessionId }, thunkApi) => {
  const session = selectSessionById(thunkApi.getState(), sessionId);
  if (!session) {
    return;
  }
  pendingSaves.set(sessionId, {
    revision: session.persistence?.revision ?? 0,
    reason: "retry",
  });
  await (runningSaves.get(sessionId) ?? startSaveLoop(sessionId, thunkApi));
});

/** Test helper: drop module-level queue state between tests. */
export function resetSessionSaveQueues(): void {
  pendingSaves.clear();
  runningSaves.clear();
}
