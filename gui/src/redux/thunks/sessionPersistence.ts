import { createAsyncThunk } from "@reduxjs/toolkit";
import { Session } from "core";
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  fullConversationConstructionIdentity,
  type FullConversationMeasurementRequest,
} from "core/util/fullConversationMetrics";
import { resolveSessionMeasurementInputs } from "../util/sessionRequestOptions";
import {
  isSubmitLatencyLoggingEnabled,
  recordSubmitLatency,
} from "../../util/submitLatency";
import {
  currentFullConversationMetricsEnvironment,
  currentFullConversationMetricsMeta,
} from "./sessionMetrics";
import {
  selectSessionById,
  selectSessionChatModel,
} from "../selectors/sessions";
import { ensureMessageIdsWithReport } from "../util/messageIds";
import { reportMessageIdFallback } from "../util/messageIdFallbackReport";
import { emitLegacyFallbackMintedEvent } from "../util/legacyMessageIdObservability";
import {
  selectMessageIdMigrationCapability,
  selectTelemetryHost,
} from "../slices/runtimeCapabilitiesSlice";
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
  setSessionFullConversationMetrics,
  setSessionPagination,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import {
  deletePendingSave,
  deleteRunningSave,
  getPendingSave,
  getRunningSave,
  pendingSaveSessionIds,
  runningSaveSessionIds,
  setPendingSave,
  setRunningSave,
  type PendingSave,
  type SessionSaveMeasurementIntent,
} from "../util/sessionSaveQueue";
import { reconcilePaginationAfterPersist } from "./sessionPaging";
import { releaseClosingSessionIfClean } from "./sessionLifecycle";
import { scheduleMessageIdMigrationIfSafe } from "./sessionMessageIdMigration";

/**
 * Phase 1/2 save path (方案.md §五.10/§七.5).
 *
 * The snapshot always comes from `sessionsById[sessionId]` — never from the
 * active session, the LRU cache or the current tab. One in-flight save per
 * session; newer requests coalesce into the latest snapshot while keeping the
 * "user submitted" and "stream terminal" boundaries as the last write.
 *
 * The queue itself lives in `util/sessionSaveQueue.ts`: it is scheduling state,
 * and the legacy message-ID migration gate must read it without importing this
 * thunk (which would be a module cycle, since this file kicks the migration).
 */

export {
  hasPendingSessionSave,
  resetSessionSaveQueues,
} from "../util/sessionSaveQueue";

type SaveReason = string;

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
  measurementIntent: SessionSaveMeasurementIntent,
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
  // 方案.md §五.16.4「保存边界（按显式开关，不按 reason）」：只有调用方声明本次保存
  // 建立了新的完整会话内容版本、且该版本仍是当前版本时才携带计量。reason 不参与判断。
  //
  // revision 校验是最后一道防线：保存发起后、载荷构造前内容又变过（例如同一回合里
  // 更晚的 mutation）就**不携带**，磁盘 metrics 保持原状并继续显示为 stale，
  // 由下一次真正的边界补上 —— 而不是把一个已经过期的中间态写成 fresh 权威值。
  let fullConversationMeasurement:
    | FullConversationMeasurementRequest
    | undefined;
  if (
    measurementIntent.kind === "conversation-version" &&
    measurementIntent.conversationRevision === session.conversationRevision
  ) {
    const model = selectSessionChatModel(state, sessionId);
    if (model) {
      // This runs synchronously inside the same task as the terminal commit: it renders
      // the system message and canonicalizes the whole construction identity, so it is
      // worth its own measurement rather than being hidden inside the save.
      const identityStartedAt = performance.now();
      const { request, identityInputs } = resolveSessionMeasurementInputs({
        state,
        session,
        model,
      });
      const constructionIdentity =
        fullConversationConstructionIdentity(identityInputs);
      recordSubmitLatency({
        phase: "terminal-identity",
        sessionId,
        durationMs: performance.now() - identityStartedAt,
      });
      fullConversationMeasurement = {
        ...request,
        conversationRevision: session.conversationRevision,
        constructionIdentity,
        schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
      };
    }
  }
  const { wireHistory, savedMergedProvenance } = stripHistoryRuntimeFields(
    session.history,
  );
  // Diagnostic for the terminal save cost: the GUI puts the **whole history** on the wire on
  // every save, and each assistant item carries the full rendered prompt it was sent, so this
  // payload grows quadratically with conversation length (a 400-turn session sums to ~47MB of
  // prompt text in a synthetic measurement). A length sum is O(n) and allocates nothing —
  // JSON.stringify to measure it would itself cost what we are trying to observe.
  if (isSubmitLatencyLoggingEnabled()) {
    let bytes = 0;
    for (const item of wireHistory) {
      const content = item.message?.content;
      bytes +=
        typeof content === "string"
          ? content.length
          : JSON.stringify(content ?? "").length;
      for (const log of item.promptLogs ?? []) {
        bytes += (log as { prompt?: string }).prompt?.length ?? 0;
      }
    }
    recordSubmitLatency({
      phase: "save-payload",
      sessionId,
      payloadMB: bytes / 1024 / 1024,
    });
  }
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
    // 磁盘 metrics 由 Core 掌管：携带计量时写新 Result，不携带时 Core 把磁盘上的原值
    // 原样保留。GUI 因此**不再**发送 `contextMetrics`（那会让簿记保存把实测 Result
    // 降级成 legacy 投影）。
    ...(fullConversationMeasurement ? { fullConversationMeasurement } : {}),
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
  const built = buildSessionPayload(
    sessionId,
    getState,
    request.measurementIntent,
  );
  if (!built) {
    return;
  }
  const { payload, savedMergedProvenance } = built;

  // Incremental updates only: a snapshot taken here would roll back any
  // revision bumped by a chunk / tool result arriving during the request
  // (方案.md §七.5).
  dispatch(markSessionSaving({ sessionId }));

  // Absolute timestamps (epoch ms, same clock as the extension host) around the request:
  // the GUI's awaited span and Core's own breakdown can then be lined up to see whether the
  // time is before Core's handler starts, inside it, or after it answered. Durations alone
  // cannot answer that (方案.md §7.2.2).
  const sentAt = Date.now();
  const requestStartedAt = performance.now();
  if (isSubmitLatencyLoggingEnabled()) {
    recordSubmitLatency({
      phase: "save-request-sent",
      sessionId,
      at: sentAt,
    });
  }
  const result = await extra.ideMessenger.request("history/save", payload);
  if (isSubmitLatencyLoggingEnabled()) {
    recordSubmitLatency({
      phase: "save-response-received",
      sessionId,
      at: Date.now(),
      durationMs: performance.now() - requestStartedAt,
    });
  }

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
  // USER_SUBMITTED contains an intentionally empty assistant placeholder and
  // is not an authoritative completed first-turn cache.
  if (
    responseIsCurrent &&
    request.reason !== "USER_SUBMITTED" &&
    result.content?.firstTurnItems !== undefined
  ) {
    // P4b-2: the same fallback report as the load paths. The dispatch below is
    // unchanged — only the reporting helper variant is new, so nothing about
    // dirty / conversationRevision / persistence moves because of the report.
    const firstTurnReport = ensureMessageIdsWithReport(
      result.content.firstTurnItems,
    );
    if (firstTurnReport.mintedCount > 0) {
      reportMessageIdFallback({
        sessionId,
        mintedCount: firstTurnReport.mintedCount,
        hostCapability: selectMessageIdMigrationCapability(getState()),
      });
      emitLegacyFallbackMintedEvent({
        mintedCount: firstTurnReport.mintedCount,
        host: selectTelemetryHost(getState()),
        messenger: extra.ideMessenger,
      });
    }
    dispatch(
      setSessionFirstTurn({
        sessionId,
        firstTurnItems: firstTurnReport.items,
      }),
    );
  }
  // 方案.md §五.16.5: accept the measurement this save wrote **only** when the
  // complete identity still describes this conversation. The identity is compared
  // against the state as it is now (the revision may have moved on while the save
  // was in flight), and the reducer re-checks the revision once more.
  const savedMetrics = result.content?.fullConversationMetrics;
  if (savedMetrics) {
    const currentMeta = currentFullConversationMetricsMeta(
      getState(),
      sessionId,
    );
    if (
      currentMeta &&
      currentMeta.conversationRevision ===
        savedMetrics.meta.conversationRevision &&
      currentMeta.constructionIdentity ===
        savedMetrics.meta.constructionIdentity &&
      currentMeta.schemaVersion === savedMetrics.meta.schemaVersion
    ) {
      // The environment stamp was validated by the same identity comparison, so
      // freshness later stays an O(1) check (方案.md §五.16.6).
      const environment = currentFullConversationMetricsEnvironment(
        getState(),
        sessionId,
      );
      if (environment) {
        dispatch(
          setSessionFullConversationMetrics({
            sessionId,
            result: savedMetrics,
            environment,
          }),
        );
      }
    }
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
    let saveFailed = false;
    try {
      while (hasQueuedSave(sessionId)) {
        const request = getPendingSave(sessionId)!;
        deletePendingSave(sessionId);
        try {
          await performSave(sessionId, request, thunkApi);
        } catch (error) {
          saveFailed = true;
          throw error;
        }
      }
    } finally {
      deleteRunningSave(sessionId);
      // Legacy message ID migration, "saved and clean" trigger (P4a).
      //
      // It has to sit here rather than inside `performSave`: the gate refuses to
      // run while a save is queued or running, and `runningSaves` still holds
      // this session until this `finally`.
      //
      // Only a successful save is announced. The gate would filter a failed one
      // anyway (`persistence.state` is `failed`), but skipping it here is what
      // keeps a repeatedly failing session from re-probing the host capability
      // on every retry — the migration still runs after the retry that works.
      if (!saveFailed) {
        void thunkApi.dispatch(scheduleMessageIdMigrationIfSafe({ sessionId }));
      }
    }
  })();
  setRunningSave(sessionId, run);
  return run;
}

function hasQueuedSave(sessionId: string): boolean {
  return getPendingSave(sessionId) !== undefined;
}

export const saveSession = createAsyncThunk<
  void,
  {
    sessionId: string;
    reason: SaveReason;
    /**
     * 方案.md §五.16.4: the caller states whether this save established a new
     * full-conversation content version (and which one). Required on purpose so a
     * new content action cannot silently skip (or silently add) a measurement.
     */
    measurementIntent: SessionSaveMeasurementIntent;
  },
  ThunkApiType
>(
  "sessions/save",
  async ({ sessionId, reason, measurementIntent }, thunkApi) => {
    const session = selectSessionById(thunkApi.getState(), sessionId);
    if (!session) {
      return;
    }
    setPendingSave(sessionId, {
      revision: session.persistence?.revision ?? 0,
      reason,
      measurementIntent,
    });
    const running = getRunningSave(sessionId);
    await (running ?? startSaveLoop(sessionId, thunkApi));
  },
);

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
  setPendingSave(sessionId, {
    revision: session.persistence?.revision ?? 0,
    reason: "flush",
    // Best-effort unload/reload flush: never the boundary that establishes a new
    // content version (a real boundary already measured, or the gate will).
    measurementIntent: { kind: "none" },
  });
  const running = getRunningSave(sessionId);
  await (running ?? startSaveLoop(sessionId, thunkApi));
});

export const flushAllPendingSessions = createAsyncThunk<
  void,
  void,
  ThunkApiType
>("sessions/flushAll", async (_, thunkApi) => {
  const ids = new Set([
    ...runningSaveSessionIds(),
    ...pendingSaveSessionIds(),
    ...Object.keys(thunkApi.getState().sessions.sessionsById),
  ]);
  await Promise.all(
    [...ids].map(async (sessionId) => {
      const session = selectSessionById(thunkApi.getState(), sessionId);
      if (!session?.dirty) {
        return;
      }
      setPendingSave(sessionId, {
        revision: session.persistence?.revision ?? 0,
        reason: "flush-all",
        measurementIntent: { kind: "none" },
      });
      await (getRunningSave(sessionId) ?? startSaveLoop(sessionId, thunkApi));
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
  setPendingSave(sessionId, {
    revision: session.persistence?.revision ?? 0,
    reason: "retry",
    // Retrying re-writes the same content; a boundary already measured it.
    measurementIntent: { kind: "none" },
  });
  await (getRunningSave(sessionId) ?? startSaveLoop(sessionId, thunkApi));
});
