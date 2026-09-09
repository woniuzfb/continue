import { createAsyncThunk } from "@reduxjs/toolkit";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { Session } from "core";
import { selectSessionById } from "../selectors/sessions";
import { ensureMessageIds } from "../util/messageIds";
import {
  markSessionPersisted,
  clearSessionConversationSummary,
  setSessionConversationSummary,
  setSessionFirstTurn,
  setSessionPagination,
  setSessionPersistenceState,
  SessionPersistenceState,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { createAndActivateSession } from "./sessionActivation";
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

function persistenceState(
  sessionId: string,
  getState: () => any,
): SessionPersistenceState {
  const session = selectSessionById(getState(), sessionId);
  return (
    session?.persistence ?? {
      state: "clean",
      revision: 0,
      persistedRevision: 0,
      hasPersistedBaseline: false,
    }
  );
}

function buildSessionPayload(
  sessionId: string,
  getState: () => any,
): Session | undefined {
  const state = getState();
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return undefined;
  }
  return {
    sessionId,
    title: session.title,
    workspaceDirectory: window.workspacePaths?.[0] || "",
    history: session.history,
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
}

async function performSave(
  sessionId: string,
  request: PendingSave,
  { dispatch, getState, extra }: any,
): Promise<void> {
  const payload = buildSessionPayload(sessionId, getState);
  if (!payload) {
    return;
  }

  const base = persistenceState(sessionId, getState);
  dispatch(
    setSessionPersistenceState({
      sessionId,
      persistence: { ...base, state: "saving" },
    }),
  );

  const result = await extra.ideMessenger.request("history/save", payload);

  if (result.status === "error") {
    dispatch(
      setSessionPersistenceState({
        sessionId,
        persistence: {
          ...base,
          state: "failed",
          error: {
            code: result.errorCode ?? "SESSION_SAVE_FAILED",
            message: result.error,
          },
        },
      }),
    );
    // Never clear dirty / pending on failure (方案.md §七.7).
    throw new Error(result.error);
  }

  // 方案.md §七.8.1: the response carries the authoritative post-merge data.
  // Only the disk accounting is applied now; firstTurnItems are loaded and
  // maintained in Phase 4 (方案.md §五.5).
  if (result.content?.totalHistoryCount !== undefined) {
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
  if (result.content?.firstTurnItems !== undefined) {
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
  if (summary?.sourceMessageId && summary.content) {
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
  } else {
    dispatch(clearSessionConversationSummary({ sessionId }));
  }

  dispatch(
    markSessionPersisted({
      sessionId,
      revision: request.revision,
      hasPersistedBaseline: true,
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

/**
 * Active-UI save entry point (方案.md §五.14): resolves the visible session,
 * flushes its save and optionally opens a new session. Call sites that used the
 * legacy `saveCurrentSession` use this instead.
 */
export const saveActiveSession = createAsyncThunk<
  void,
  { openNewSession: boolean },
  ThunkApiType
>("sessions/saveActive", async ({ openNewSession }, { dispatch, getState }) => {
  const sessionId = getState().sessions.activeSessionId;
  const runtime = sessionId
    ? getState().sessions.sessionsById[sessionId]
    : undefined;
  if (
    sessionId &&
    runtime &&
    runtime.history.length > 0 &&
    (runtime.dirty || runtime.title === NEW_SESSION_TITLE)
  ) {
    await dispatch(flushSessionSave({ sessionId }));
  }
  if (openNewSession) {
    await dispatch(createAndActivateSession({ origin: "new" }));
  }
});

/** Test helper: drop module-level queue state between tests. */
export function resetSessionSaveQueues(): void {
  pendingSaves.clear();
  runningSaves.clear();
}
