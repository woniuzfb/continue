import { createAsyncThunk } from "@reduxjs/toolkit";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { v4 as uuidv4 } from "uuid";
import { selectSessionById, selectTabDescriptor } from "../selectors/sessions";
import {
  refreshSessionMetadata as refreshSessionMetadataAction,
  removeSessionMetadata,
  setLastSessionId,
} from "../slices/sessionCatalogSlice";
import {
  closeSessionTabTransaction,
  initialSessionRuntime,
  removeSessionRuntime,
  setSessionClosing,
  setTabDescriptor,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { mergeSettings } from "../util/mergeSettings";
import { flushSessionSave } from "./sessionPersistence";
import {
  activateSessionTab,
  completeSessionActivation,
  createAndActivateSession,
  loadSessionRuntime,
} from "./sessionActivation";
import { rejectToolCall } from "./sessionTools";
import { stopSessionStream } from "./sessionStreams";

/**
 * Phase 1 session lifecycle glue (方案.md §五.6/§五.16/§五.19).
 *
 * These are the entry points that make `sessionsById` the runtime owner:
 * `openSessionTab` creates the descriptor for a session that only exists in the
 * catalog and then runs the activation pipeline, so a session opened from the
 * History page, a deep link or startup gets exactly one runtime.
 *
 * Nothing here reads the legacy active session; the catalog and the target
 * sessionId are the only inputs.
 */

/** Refresh the global session list (catalog slice, 方案.md §五.6). */
export const refreshSessionCatalog = createAsyncThunk<
  void,
  { offset?: number; limit?: number },
  ThunkApiType
>("sessions/refreshCatalog", async ({ offset, limit }, { dispatch, extra }) => {
  const result = await extra.ideMessenger.request("history/list", {
    limit,
    offset,
  });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  dispatch(
    refreshSessionMetadataAction({
      metadata: result.content,
      isLoading: false,
    }),
  );
});

/**
 * Open (or re-activate) a session tab.
 *
 * A hidden owner is reused as-is: reopening a session from History must never
 * create a second runtime (方案.md §五.19).
 */
export const openSessionTab = createAsyncThunk<
  void,
  { sessionId: string; title?: string },
  ThunkApiType
>("sessions/openTab", async ({ sessionId, title }, { dispatch, getState }) => {
  const state = getState();

  if (
    !selectSessionById(state, sessionId) &&
    !selectTabDescriptor(state, sessionId)
  ) {
    const metadata = state.sessionCatalog.allSessionMetadata.find(
      (entry) => entry.sessionId === sessionId,
    );
    dispatch(
      setTabDescriptor({
        descriptor: {
          sessionId,
          title: title ?? metadata?.title ?? sessionId,
          loadState: "unloaded",
        },
      }),
    );
  }

  await dispatch(activateSessionTab({ sessionId }));
  dispatch(setLastSessionId({ lastSessionId: sessionId }));
});

/**
 * Startup entry point: restore the last opened session, or create a new empty
 * one when there is nothing to restore (方案.md §五.18).
 */
export const bootstrapLastSession = createAsyncThunk<void, void, ThunkApiType>(
  "sessions/bootstrapLast",
  async (_, { dispatch, getState }) => {
    if (getState().sessionCatalog.allSessionMetadata.length === 0) {
      try {
        await dispatch(refreshSessionCatalog({})).unwrap();
      } catch (e) {
        // A failed listing must not block startup.
        console.warn("Failed to refresh session catalog on startup", e);
      }
    }

    const state = getState();
    const lastSessionId = state.sessionCatalog.lastSessionId;
    const exists =
      !!lastSessionId &&
      state.sessionCatalog.allSessionMetadata.some(
        (entry) => entry.sessionId === lastSessionId,
      );

    if (!lastSessionId || !exists) {
      await dispatch(createAndActivateSession({ origin: "new" }));
      return;
    }

    await dispatch(openSessionTab({ sessionId: lastSessionId }));
  },
);

/**
 * Startup entry point for a rehydrated store (方案.md §五.16).
 *
 * After redux-persist restores the tab projection, every descriptor is
 * `unloaded` and the active one must be loaded from disk immediately. The
 * target is resolved *when this thunk runs* — redux-persist rehydrates
 * asynchronously, so `activeSessionId` is normally still empty at first render
 * and must never be captured there.
 *
 * No descriptors at all (fresh install, or a snapshot without tabs) falls back
 * to `bootstrapLastSession`, which restores the catalog pointer or creates the
 * first empty session.
 *
 * Idempotent: the shell (config load) and the empty `SessionViews` placeholder
 * both call it, and React StrictMode runs the config effect twice. Concurrent
 * calls share one run, otherwise an empty store would be bootstrapped twice and
 * create two sessions.
 */
let ensureActiveSessionLoadInFlight: Promise<void> | undefined;

export const ensureActiveSessionLoaded = createAsyncThunk<
  void,
  void,
  ThunkApiType
>("sessions/ensureActiveLoaded", async (_, { dispatch, getState }) => {
  if (ensureActiveSessionLoadInFlight) {
    return ensureActiveSessionLoadInFlight;
  }

  const run = (async () => {
    const state = getState();
    const activeSessionId = state.sessions.activeSessionId;
    const target =
      activeSessionId && selectTabDescriptor(state, activeSessionId)
        ? activeSessionId
        : state.sessions.tabOrder[state.sessions.tabOrder.length - 1];

    if (!target) {
      await dispatch(bootstrapLastSession());
      return;
    }

    await dispatch(openSessionTab({ sessionId: target }));
  })().finally(() => {
    ensureActiveSessionLoadInFlight = undefined;
  });

  ensureActiveSessionLoadInFlight = run;
  return run;
});

/**
 * Test hook: drop the in-flight guard. Production never needs this, but a test
 * that leaves the startup IPC pending would otherwise block every later boot.
 */
export function resetEnsureActiveSessionLoad(): void {
  ensureActiveSessionLoadInFlight = undefined;
}

/**
 * Delete a session (方案.md §五.19): stop its own stream, close its approvals
 * without continuing the loop, release the runtime, delete on disk and
 * activate a neighbour. Other sessions are never touched.
 */
export const deleteSessionRuntime = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/deleteRuntime",
  async ({ sessionId }, { dispatch, getState, extra }) => {
    const state = getState();
    const runtime = selectSessionById(state, sessionId);
    const requestId = runtime?.stream.requestId;

    // 1. Stop this session's own stream only.
    if (runtime?.stream.status === "streaming" && requestId) {
      await dispatch(stopSessionStream({ sessionId, requestId }));
    }

    // 2. Wait for the pending save, but never block deletion on a failure.
    if (runtime?.dirty) {
      try {
        await dispatch(flushSessionSave({ sessionId })).unwrap();
      } catch (e) {
        console.warn(`Failed to flush session ${sessionId} before delete`, e);
      }
    }

    // 3. Close pending approvals without continuing the tool loop.
    const pendingApprovals = selectSessionById(getState(), sessionId)
      ?.history.flatMap((item) => item.toolCallStates ?? [])
      .filter((toolCallState) => toolCallState.status === "generated");
    if (requestId && pendingApprovals?.length) {
      for (const toolCallState of pendingApprovals) {
        await dispatch(
          rejectToolCall({
            sessionId,
            requestId,
            toolCallId: toolCallState.toolCallId,
            deferContinuation: true,
          }),
        );
      }
    }

    // 4. Remove the tab and release the owner. Deleting a background tab must
    // not move the visible tab (方案.md §五.19).
    const order = getState().sessions.tabOrder;
    const index = order.indexOf(sessionId);
    const wasActive = getState().sessions.activeSessionId === sessionId;
    const replacementSessionId =
      index >= 0 && wasActive
        ? (order[index + 1] ?? order[index - 1])
        : undefined;
    const newEmptySession =
      index >= 0 && wasActive && replacementSessionId === undefined
        ? initialSessionRuntime(uuidv4(), NEW_SESSION_TITLE, {
            // C3 (方案.md §五.17/§五.19): the replacement empty runtime seeds the
            // merge mirror through the same helper as every other construction
            // path, so a global `false` never degrades to the `?? true` fallback.
            ...mergeSettings(getState()),
          })
        : undefined;

    if (index >= 0) {
      dispatch(setSessionClosing({ sessionId, closing: true }));
      dispatch(
        closeSessionTabTransaction({
          sessionId,
          wasActive,
          replacementSessionId,
          newEmptySession,
        }),
      );
    }
    dispatch(removeSessionRuntime({ sessionId }));
    dispatch(removeSessionMetadata({ sessionId }));

    // 5. Disk delete; a failure surfaces to the caller but the tab is gone.
    const result = await extra.ideMessenger.request("history/delete", {
      id: sessionId,
    });
    if (result.status === "error") {
      throw new Error(result.error);
    }

    // 6. Finish activation of whatever is now visible.
    const nextActive = getState().sessions.activeSessionId;
    if (nextActive) {
      await dispatch(completeSessionActivation({ sessionId: nextActive }));
    }
  },
);

/**
 * Hidden-owner release (方案.md §八): a closed session keeps its runtime while
 * it streams, saves, fails or awaits approval. Once it is clean, idle and has
 * no pending approval, the owner is released.
 */
export const releaseClosingSessionIfClean = createAsyncThunk<
  boolean,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/releaseClosingIfClean",
  async ({ sessionId }, { dispatch, getState }) => {
    const state = getState();
    const session = selectSessionById(state, sessionId);
    if (!session || !session.lifecycle.closing) {
      return false;
    }
    // Still visible: the tab was reopened.
    if (selectTabDescriptor(state, sessionId)) {
      return false;
    }
    if (session.stream.status === "streaming") {
      return false;
    }
    if (session.pendingApprovalCount > 0) {
      return false;
    }
    if (session.dirty || session.persistence?.state === "failed") {
      return false;
    }
    dispatch(removeSessionRuntime({ sessionId }));
    return true;
  },
);

/** Ensure a runtime exists for a session without activating it. */
export const ensureSessionRuntime = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>("sessions/ensureRuntime", async ({ sessionId }, { dispatch, getState }) => {
  if (selectSessionById(getState(), sessionId)) {
    return;
  }
  await dispatch(loadSessionRuntime({ sessionId }));
});
