import { createAsyncThunk } from "@reduxjs/toolkit";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { v4 as uuidv4 } from "uuid";
import { normalizePersistedContextMetrics } from "../util/fullConversationMetrics";
import { selectSessionById, selectTabDescriptor } from "../selectors/sessions";
import { setActiveSessionModelProjection } from "../slices/configSlice";
import {
  closeSessionTabTransaction,
  createSessionRuntime,
  initialSessionRuntime,
  removeSessionRuntime,
  setActiveSessionId,
  setSessionClosing,
  setSessionInterrupted,
  setTabLoadState,
  refreshSessionFullConversationMetricsEnvironment,
} from "../slices/sessionsSlice";
import type { ThunkApiType } from "../store";
import { mergeSettings } from "../util/mergeSettings";
import { ensureMessageIdsWithReport } from "../util/messageIds";
import { reportMessageIdFallback } from "../util/messageIdFallbackReport";
import { emitLegacyFallbackMintedEvent } from "../util/legacyMessageIdObservability";
import {
  selectMessageIdMigrationCapability,
  selectTelemetryHost,
} from "../slices/runtimeCapabilitiesSlice";
import { extractFirstTurnItems } from "core/util/firstTurn";
import { latestSummaryOf } from "../slices/sessionHistory";
import type { ChatHistoryItem } from "core";
import {
  currentFullConversationMetricsEnvironment,
  measureFullConversationForMetrics,
  needsFullConversationMetricsRecompute,
  sessionConstructionIdentity,
} from "./sessionMetrics";
import { FULL_CONVERSATION_METRICS_SCHEMA_VERSION } from "core/util/fullConversationMetrics";
import { getSession, getSessionPage } from "./session";
import { hasUnresumableTurn } from "./sessionInterruption";
import { scheduleMessageIdMigrationIfSafe } from "./sessionMessageIdMigration";

/**
 * Phase 1 tab activation pipeline (方案.md §五.16/§五.17/§五.19).
 *
 * Every entry point takes an explicit sessionId. Activation never copies
 * history, never touches another session's stream/paging state, and never
 * persists the model selection — that belongs to an explicit user change.
 */

export const projectSessionModelToActiveUi = createAsyncThunk<
  void,
  { sessionId: string; chatModelTitle?: string },
  ThunkApiType
>(
  "sessions/projectModelToActiveUi",
  async ({ sessionId, chatModelTitle }, { dispatch, getState }) => {
    // 方案.md §五.17/§五.20: the projection describes the *visible* tab. A slow
    // activation that finishes after the user switched away must not overwrite
    // the newer tab's projection — guarded here as well as at the call site so
    // every future entry point is covered.
    if (getState().sessions.activeSessionId !== sessionId) {
      return;
    }
    const models = getState().config.config?.modelsByRole?.chat ?? [];
    const model = chatModelTitle
      ? (models.find((m) => m.title === chatModelTitle) ?? null)
      : null;
    // Runtime projection only: no updateConfig, no config/updateSelectedModel
    // IPC, no markSessionDirty (方案.md §五.17).
    dispatch(setActiveSessionModelProjection({ model }));
  },
);

export const loadSessionRuntime = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/loadRuntime",
  async ({ sessionId }, { dispatch, getState, extra }) => {
    const state = getState();
    const descriptor = selectTabDescriptor(state, sessionId);
    if (!descriptor) {
      return;
    }
    if (selectSessionById(state, sessionId)) {
      dispatch(setTabLoadState({ sessionId, loadState: "loaded" }));
      return;
    }
    if (descriptor.loadState === "loading") {
      return;
    }

    dispatch(setTabLoadState({ sessionId, loadState: "loading" }));

    const ui = getState().config.config?.ui;
    const limit = ui?.lazyLoadHistoryInitialCount ?? 4;

    try {
      let session;
      let hasMore = false;
      let totalCount = 0;
      let loadedOffset = 0;
      let pageFirstTurnItems: ChatHistoryItem[] | undefined;
      let pageLatestSummary:
        | {
            sourceMessageId: string;
            sourceAbsoluteIndex: number;
            content: string;
          }
        | undefined;

      if (ui?.lazyLoadHistory) {
        const page = await getSessionPage(extra.ideMessenger, sessionId, limit);
        session = page.session;
        pageFirstTurnItems = page.firstTurnItems;
        pageLatestSummary = page.latestConversationSummary;
        hasMore = page.hasMore;
        totalCount = page.totalCount;
        loadedOffset = page.loadedOffset;
      } else {
        session = await getSession(extra.ideMessenger, sessionId);
        totalCount = session.history.length;
      }

      const historyReport = ensureMessageIdsWithReport(session.history);
      const history = historyReport.items;
      // P4b-2: report the GUI fallback instead of hiding it. Minting here is the
      // legacy path when the disk response carries no ids; it must not fail the
      // load, mark the session dirty, or be mistaken for a completed migration.
      const firstTurnReport = hasMore
        ? ensureMessageIdsWithReport(pageFirstTurnItems ?? [])
        : undefined;
      const mintedCount =
        historyReport.mintedCount + (firstTurnReport?.mintedCount ?? 0);
      if (mintedCount > 0) {
        reportMessageIdFallback({
          sessionId,
          mintedCount,
          hostCapability: selectMessageIdMigrationCapability(getState()),
        });
        // P5a: a separate, closed-allow-list event — the P4b report is never
        // spread into it (it carries `sessionId`).
        emitLegacyFallbackMintedEvent({
          mintedCount,
          host: selectTelemetryHost(getState()),
          messenger: extra.ideMessenger,
        });
      }
      const persistedSnapshot = normalizePersistedContextMetrics(
        session.contextMetrics,
      );
      const runtime = initialSessionRuntime(sessionId, session.title, {
        history,
        // Phase 4/5 (方案.md §五.5/§十三.4): the first turn comes from the disk
        // — from the page response when paging, or computed on a full load.
        firstTurnItems: hasMore
          ? (firstTurnReport?.items ?? [])
          : extractFirstTurnItems(history),
        mode: session.mode ?? "chat",
        chatModelTitle: session.chatModelTitle ?? undefined,
        hasReasoningEnabled: session.hasReasoningEnabled,
        reasoningPreferenceSource: session.reasoningPreferenceSource,
        // 方案.md §十一: without the authoritative summary a lazy-loaded
        // session loses `conversationSummaryOverride` after a restart.
        // The paged path takes the authoritative summary from the response;
        // a full load derives it from the complete history (same rule as Core).
        latestConversationSummary:
          pageLatestSummary ?? latestSummaryOf(history),
        // 方案.md §五.16.5: 磁盘可能是历史 legacy `didPrune` 形状，也可能是 Stage 2D
        // 起写入的完整 Result。两种形状在同一处归一：Result ⇒ 数值 + 身份；legacy ⇒
        // 只有数值（无身份即 stale）。
        //
        // 归一化的 freshness **不**被存下来：它是「与**当前**环境可比」的意思，而当前环境
        // 只能由门禁（激活时的 `ensureFullConversationMetrics`）去比。这里**刻意不写**
        // 环境指纹，所以磁盘恢复的快照在 selector 眼里先是 stale，首次激活由门禁分两种：
        //
        //   三项身份（schema / conversationRevision / canonical identity）都能证明相等
        //     ⇒ 只修复环境指纹（`refreshSessionFullConversationMetricsEnvironment`），
        //       不发任何请求，直接回到 fresh；
        //   任何一项证明不了或不等
        //     ⇒ 发起一次重算（`history/measureConversation`）。
        //
        // 常见情形是重算：`conversationRevision` 在重启后从 0 重新开始，而磁盘 meta 记的是
        // 保存当刻的版本号，两者通常不等（已知限制 #50）。这里也不把磁盘 revision 搬进
        // runtime —— 它是另一个量（§五.16.1：revision 是本进程的内容版本计数，不是持久化代次）。
        fullConversationMetrics: persistedSnapshot.metrics,
        fullConversationMetricsMeta: persistedSnapshot.meta,
        ...mergeSettings(getState()),
        pagination: {
          truncated: hasMore,
          loadedOffset,
          totalCount,
          loadedDiskCount: hasMore ? history.length : undefined,
          hasMore,
          loading: false,
          requestGeneration: 0,
          persistPending: false,
        },
      });

      dispatch(createSessionRuntime({ session: runtime }));
      // 方案.md §八: a restart cannot resume a turn whose tool calls are still
      // generating/calling; the session is marked interrupted for the
      // Retry/Dismiss entry point.
      if (hasUnresumableTurn(history)) {
        dispatch(setSessionInterrupted({ sessionId, interrupted: true }));
      }
      dispatch(setTabLoadState({ sessionId, loadState: "loaded" }));
      // P4a: legacy message ID migration, first trigger. Deliberately fired
      // *after* the runtime is usable and never awaited — the migration is a
      // file-maintenance side effect and must not delay session display, editor
      // restore, the model projection or the context metrics circle. Every
      // trigger goes through the same schedule thunk, so none of them owns any
      // part of the "is it safe" decision.
      void dispatch(scheduleMessageIdMigrationIfSafe({ sessionId }));
    } catch (e) {
      // Keep the descriptor (retry UI) and never create a pseudo-empty
      // runtime (方案.md §五.23).
      console.warn("loadSessionRuntime failed", e);
      dispatch(setTabLoadState({ sessionId, loadState: "failed" }));
      throw e;
    }
  },
);

export const completeSessionActivation = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/completeActivation",
  async ({ sessionId }, { dispatch, getState }) => {
    if (!selectTabDescriptor(getState(), sessionId)) {
      return;
    }
    const runtime = selectSessionById(getState(), sessionId);
    if (!runtime) {
      await dispatch(loadSessionRuntime({ sessionId }));
    }
    const loaded = selectSessionById(getState(), sessionId);
    if (!loaded) {
      return;
    }
    // A slow disk load can finish after the user activated another tab. That
    // activation no longer owns the visible UI, so it must not project a model
    // or trigger a background compile (方案.md §五.16/§五.17).
    if (getState().sessions.activeSessionId !== sessionId) {
      return;
    }
    void dispatch(
      projectSessionModelToActiveUi({
        sessionId,
        chatModelTitle: loaded.chatModelTitle,
      }),
    );
    // 方案.md §五.16: a missing or stale metrics snapshot is recomputed on
    // activation. The thunk owns the gate (model identity + history revision +
    // schema version), so an already valid loaded tab never recompiles.
    void dispatch(ensureFullConversationMetrics({ sessionId }));
  },
);

export const activateSessionTab = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>("sessions/activateTab", async ({ sessionId }, { dispatch, getState }) => {
  if (!selectTabDescriptor(getState(), sessionId)) {
    return;
  }
  // Activate first so the UI responds immediately, then finish the
  // side-effects; a slow disk load never blocks the switch.
  //
  // 方案.md §七.11: switching tabs must not save. Every content mutation already
  // enqueues its own save (§七.2), so the Phase 1 transitional save is gone —
  // activation only selects the target and applies the side effects below.
  dispatch(setActiveSessionId({ sessionId }));
  await dispatch(completeSessionActivation({ sessionId }));
});

/** Reopening a session must reuse an existing (possibly hidden) runtime. */
export const reopenOrActivateSession = activateSessionTab;

export const createAndActivateSession = createAsyncThunk<
  void,
  { origin: "new" | "explicit"; title?: string; sessionId?: string },
  ThunkApiType
>(
  "sessions/createAndActivate",
  async ({ title, sessionId }, { dispatch, getState }) => {
    const id = sessionId ?? uuidv4();
    const runtime = initialSessionRuntime(id, title ?? NEW_SESSION_TITLE, {
      ...mergeSettings(getState()),
    });
    dispatch(createSessionRuntime({ session: runtime }));
    dispatch(setActiveSessionId({ sessionId: id }));
    dispatch(setActiveSessionModelProjection({ model: null }));
  },
);

export const focusSessionEditor = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>("sessions/focusEditor", async ({ sessionId }, { dispatch, getState }) => {
  // Phase 1 has a single editor instance: activating the tab restores its
  // draft. Per-tab focus/instance arrives with the Phase 4 provider split.
  if (getState().sessions.activeSessionId !== sessionId) {
    await dispatch(activateSessionTab({ sessionId }));
  }
});

export const closeSessionTab = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>("sessions/closeTab", async ({ sessionId }, { dispatch, getState }) => {
  const state = getState();
  const order = state.sessions.tabOrder;
  const index = order.indexOf(sessionId);
  if (index < 0) {
    return;
  }
  const runtime = selectSessionById(state, sessionId);
  // 方案.md §五.19: only closing the *visible* tab may move the visible tab.
  const wasActive = state.sessions.activeSessionId === sessionId;

  // Compute the neighbour up front: right, then left, else a new empty tab.
  const replacementSessionId = wasActive
    ? (order[index + 1] ?? order[index - 1])
    : undefined;
  const needsNewEmptySession = wasActive && replacementSessionId === undefined;
  const newEmptySession = needsNewEmptySession
    ? initialSessionRuntime(uuidv4(), NEW_SESSION_TITLE, {
        ...mergeSettings(state),
      })
    : undefined;

  // Owner may only be released when it is clean, idle and has no approval.
  const canReleaseOwner =
    runtime !== undefined &&
    runtime.stream.status !== "streaming" &&
    runtime.pendingApprovalCount === 0 &&
    !runtime.dirty;

  if (runtime) {
    dispatch(setSessionClosing({ sessionId, closing: true }));
  }

  dispatch(
    closeSessionTabTransaction({
      sessionId,
      wasActive,
      replacementSessionId,
      newEmptySession,
    }),
  );

  if (canReleaseOwner) {
    dispatch(removeSessionRuntime({ sessionId }));
  }

  if (!wasActive) {
    // Closing a background tab never re-activates anything.
    return;
  }

  // The new empty tab must run the same projection path as any other
  // activation, otherwise it keeps the closed session's model projection
  // (方案.md §五.17/§五.19).
  const nextActiveSessionId = replacementSessionId ?? newEmptySession?.id;
  if (nextActiveSessionId) {
    void dispatch(
      completeSessionActivation({ sessionId: nextActiveSessionId }),
    );
  }
});

export const ensureFullConversationMetrics = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/ensureContextMetrics",
  async ({ sessionId }, { dispatch, getState }) => {
    // Recompute only when the stored snapshot cannot be trusted for this
    // session (方案.md §五.16 重算门禁): missing, different model, different
    // history revision or incompatible schema. Switching tabs must not compile.
    if (!needsFullConversationMetricsRecompute(getState(), sessionId)) {
      // The gate just proved the canonical identity still matches (or could not
      // resolve one at all). When it *did* prove it, also refresh the cheap
      // environment stamp: the stamp over-reports staleness by design, and a
      // permanently stale snapshot would keep "fresh-only" consumers idle
      // (方案.md §五.16.6). A gate that could not resolve an identity repairs
      // nothing — this must stay the conservative direction.
      const state = getState();
      const session = selectSessionById(state, sessionId);
      const identity = sessionConstructionIdentity(state, sessionId);
      const meta = session?.fullConversationMetricsMeta;
      if (
        identity !== undefined &&
        meta?.constructionIdentity === identity &&
        meta.conversationRevision === session?.conversationRevision &&
        meta.schemaVersion === FULL_CONVERSATION_METRICS_SCHEMA_VERSION
      ) {
        const environment = currentFullConversationMetricsEnvironment(
          state,
          sessionId,
        );
        if (environment) {
          dispatch(
            refreshSessionFullConversationMetricsEnvironment({
              sessionId,
              environment,
            }),
          );
        }
      }
      return;
    }
    await dispatch(measureFullConversationForMetrics({ sessionId }));
  },
);
