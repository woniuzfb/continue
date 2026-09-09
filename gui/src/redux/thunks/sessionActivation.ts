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
  setTabLoadState,
} from "../slices/sessionsSlice";
import type { RootState, ThunkApiType } from "../store";
import { ensureMessageIds } from "../util/messageIds";
import {
  compileSessionChatForContextMetrics,
  needsContextMetricsRecompute,
} from "./sessionMetrics";
import { getSession, getSessionPage } from "./session";

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

      if (ui?.lazyLoadHistory) {
        const page = await getSessionPage(extra.ideMessenger, sessionId, limit);
        session = page.session;
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
        mode: session.mode ?? "chat",
        chatModelTitle: session.chatModelTitle ?? undefined,
        hasReasoningEnabled: (session as { hasReasoningEnabled?: boolean })
          .hasReasoningEnabled,
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
    if (runtime) {
      dispatch(
        projectSessionModelToActiveUi({
          sessionId,
          chatModelTitle: runtime.chatModelTitle,
        }),
      );
      return;
    }
    await dispatch(loadSessionRuntime({ sessionId }));
    const loaded = selectSessionById(getState(), sessionId);
    if (loaded) {
      dispatch(
        projectSessionModelToActiveUi({
          sessionId,
          chatModelTitle: loaded.chatModelTitle,
        }),
      );
    }
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

  // Compute the neighbour up front: right, then left, else a new empty tab.
  const replacementSessionId = order[index + 1] ?? order[index - 1];
  const needsNewEmptySession = replacementSessionId === undefined;
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
      replacementSessionId,
      newEmptySession,
    }),
  );

  if (canReleaseOwner) {
    dispatch(removeSessionRuntime({ sessionId }));
  }

  if (replacementSessionId) {
    void dispatch(
      completeSessionActivation({ sessionId: replacementSessionId }),
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
