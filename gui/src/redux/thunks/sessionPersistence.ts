import { createAsyncThunk } from "@reduxjs/toolkit";
import { Session } from "core";
import { selectSessionById } from "../selectors/sessions";
import {
  markSessionPersisted,
  setSessionPersistenceState,
  SessionPersistenceState,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";

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

  dispatch(
    markSessionPersisted({
      sessionId,
      revision: request.revision,
      hasPersistedBaseline: true,
    }),
  );
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
