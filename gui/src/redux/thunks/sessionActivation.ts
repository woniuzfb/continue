import { createAsyncThunk } from "@reduxjs/toolkit";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { v4 as uuidv4 } from "uuid";
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
} from "../slices/sessionsSlice";
import type { RootState, ThunkApiType } from "../store";
import { ensureMessageIds } from "../util/messageIds";
import { firstTurnItemsOf, latestSummaryOf } from "../slices/sessionHistory";
import type { ChatHistoryItem } from "core";
import {
  compileSessionChatForContextMetrics,
  needsContextMetricsRecompute,
} from "./sessionMetrics";
import { getSession, getSessionPage } from "./session";
import { enqueueSessionSave } from "./sessionPersistence";
import { hasUnresumableTurn } from "./sessionInterruption";

/**
 * Phase 1 tab activation pipeline (方案.md §五.16/§五.17/§五.19).
 *
 * Every entry point takes an explicit sessionId. Activation never copies
 * history, never touches another session's stream/paging state, and never
 * persists the model selection — that belongs to an explicit user change.
 */

function mergeSettings(state: RootState) {
  const ui = state.config.config?.ui;
  return {
    dontMergeReplyBubbles: ui?.dontMergeReplyBubbles ?? true,
    dontMergeHistoricalReplyBubbles:
      ui?.dontMergeHistoricalReplyBubbles ?? true,
  };
}

export const projectSessionModelToActiveUi = createAsyncThunk<
  void,
  { sessionId: string; chatModelTitle?: string },
  ThunkApiType
>(
  "sessions/projectModelToActiveUi",
  async ({ chatModelTitle }, { dispatch, getState }) => {
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

      const history = ensureMessageIds(session.history);
      const runtime = initialSessionRuntime(sessionId, session.title, {
        history,
        // Phase 4/5 (方案.md §五.5/§十三.4): the first turn comes from the disk
        // — from the page response when paging, or computed on a full load.
        firstTurnItems: hasMore
          ? ensureMessageIds(pageFirstTurnItems ?? [])
          : firstTurnItemsOf(history),
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
        contextMetrics: session.contextMetrics,
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
    const active = selectSessionById(getState(), sessionId);
    if (!active) {
      return;
    }
    void dispatch(
      projectSessionModelToActiveUi({
        sessionId,
        chatModelTitle: active.chatModelTitle,
      }),
    );
    // 方案.md §五.16: a missing or stale metrics snapshot is recomputed on
    // activation. The thunk owns the gate (model identity + history revision +
    // schema version), so an already valid loaded tab never recompiles.
    void dispatch(ensureSessionContextMetrics({ sessionId }));
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
  const outgoingSessionId = getState().sessions.activeSessionId;
  // Activate first so the UI responds immediately, then finish the
  // side-effects; a slow disk load never blocks the switch.
  dispatch(setActiveSessionId({ sessionId }));
  // Phase 1 transitional save (方案.md §五.15): switching out persists the
  // outgoing session in the background.
  if (outgoingSessionId && outgoingSessionId !== sessionId) {
    const outgoing = selectSessionById(getState(), outgoingSessionId);
    if (outgoing?.dirty) {
      void dispatch(
        enqueueSessionSave({
          sessionId: outgoingSessionId,
          reason: "TAB_SWITCH",
        }),
      );
    }
  }
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

export const ensureSessionContextMetrics = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/ensureContextMetrics",
  async ({ sessionId }, { dispatch, getState }) => {
    // Recompute only when the stored snapshot cannot be trusted for this
    // session (方案.md §五.16 重算门禁): missing, different model, different
    // history revision or incompatible schema. Switching tabs must not compile.
    if (!needsContextMetricsRecompute(getState(), sessionId)) {
      return;
    }
    await dispatch(compileSessionChatForContextMetrics({ sessionId }));
  },
);
