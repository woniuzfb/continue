import { createAsyncThunk } from "@reduxjs/toolkit";
import { selectSessionById } from "../selectors/sessions";
import {
  prependSessionHistory,
  setSessionHistory,
  setSessionHistoryLoading,
  setSessionPagination,
  trimSessionHistoryWindow,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { getLazyLoadTrimLimit, planHistoryTrim } from "../util/lazyLoadHistory";
import { ensureMessageIds } from "../util/messageIds";

/**
 * Phase 1 paging (方案.md §五.12). Every request captures sessionId +
 * requestGeneration + loadedDiskCount and only writes back to that session;
 * a tab switch never invalidates a legitimate in-flight page.
 */

export const loadMoreHistory = createAsyncThunk<
  void,
  { sessionId: string; requestGeneration?: number },
  ThunkApiType
>(
  "sessions/loadMoreHistory",
  async ({ sessionId, requestGeneration }, { getState, dispatch, extra }) => {
    const session = selectSessionById(getState(), sessionId);
    if (!session) {
      return;
    }
    const { pagination } = session;
    // Discard conditions (方案.md §五.12): already loading, nothing more to
    // load, unpersisted tail, or an in-flight stream on this session.
    if (
      pagination.loading ||
      !pagination.truncated ||
      !pagination.hasMore ||
      pagination.persistPending ||
      session.stream.status === "streaming"
    ) {
      return;
    }
    if (
      requestGeneration !== undefined &&
      requestGeneration !== pagination.requestGeneration
    ) {
      return;
    }

    const generation = pagination.requestGeneration;
    const loadedCount = pagination.loadedDiskCount ?? session.history.length;
    const pageSize = getState().config.config.ui?.lazyLoadHistoryPageSize ?? 4;

    dispatch(setSessionHistoryLoading({ sessionId, loading: true }));

    try {
      const res = await extra.ideMessenger.request("history/loadPage", {
        id: sessionId,
        offset: loadedCount,
        limit: pageSize,
      });

      if (res.status === "error") {
        dispatch(setSessionHistoryLoading({ sessionId, loading: false }));
        return;
      }

      const current = selectSessionById(getState(), sessionId);
      if (
        !current ||
        current.pagination.requestGeneration !== generation ||
        !current.pagination.truncated ||
        current.pagination.persistPending ||
        (current.pagination.loadedDiskCount ?? current.history.length) !==
          loadedCount
      ) {
        dispatch(setSessionHistoryLoading({ sessionId, loading: false }));
        return;
      }

      const { items, hasMore, total } = res.content;
      dispatch(
        prependSessionHistory({
          sessionId,
          items: ensureMessageIds(items),
          hasMore,
          newLoadedOffset: total - loadedCount - items.length,
          totalCount: total,
        }),
      );
    } catch (e) {
      console.warn("loadMoreHistory error:", e);
      dispatch(setSessionHistoryLoading({ sessionId, loading: false }));
    }
  },
);

export const loadFullHistory = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/loadFullHistory",
  async ({ sessionId }, { getState, dispatch, extra }) => {
    const session = selectSessionById(getState(), sessionId);
    if (!session || !session.pagination.truncated) {
      return;
    }

    // Capture the window identity before awaiting: the merge must describe the
    // same window the request was issued for (方案.md §五.12).
    const generation = session.pagination.requestGeneration;
    const headCount = session.pagination.loadedOffset ?? 0;

    const result = await extra.ideMessenger.request("history/load", {
      id: sessionId,
    });
    if (result.status === "error") {
      // Never silently continue on a partial history: the caller unwraps and
      // aborts the send instead of overwriting the session file with a tail.
      throw new Error(`loadFullHistory failed: ${result.error}`);
    }

    // Re-read after the await: the session may have received a stream chunk,
    // tool result, edit or a concurrent full load while the disk was reading.
    // Merging the pre-await snapshot would silently drop those updates.
    const current = selectSessionById(getState(), sessionId);
    if (!current) {
      return;
    }
    if (current.pagination.requestGeneration !== generation) {
      return;
    }
    if ((current.pagination.loadedOffset ?? 0) !== headCount) {
      // The window moved (or another full load already finished).
      return;
    }

    const diskHistory = result.content.history;

    // Same guard as the legacy thunk: a truncated session claims headCount
    // frozen head items. If disk is shorter, merging would drop the head and a
    // later save would persist the tail only.
    if (diskHistory.length < headCount) {
      throw new Error(
        `loadFullHistory: on-disk history (${diskHistory.length}) is shorter ` +
          `than the expected frozen head (${headCount}). Refusing to merge ` +
          `a partial context and overwrite the session file; aborting send.`,
      );
    }

    const safeHeadCount = Math.min(headCount, diskHistory.length);
    const mergedHistory = [
      ...diskHistory.slice(0, safeHeadCount),
      ...current.history,
    ];

    dispatch(
      setSessionHistory({
        sessionId,
        history: ensureMessageIds(mergedHistory),
      }),
    );
    dispatch(
      setSessionPagination({
        sessionId,
        pagination: {
          truncated: false,
          loadedOffset: 0,
          loadedDiskCount: undefined,
          hasMore: false,
          loading: false,
        },
      }),
    );
  },
);

/**
 * 方案.md §九.5/§九.7: after a save proves the window is on disk, release the
 * frozen head from memory by trimming the visible window to
 * `max(lazyLoadHistoryInitialCount, 当前完整回合)`.
 *
 * Self-guarding so it is safe to call from any save path: every condition is
 * re-read from state, and the caller only supplies the authoritative disk count
 * from the matching `history/save` response.
 *
 * Deliberately out of scope for this step: 方案.md §九.8(切出后台 trim) and
 * §九.9(流式期间 trim 已落盘旧头部) — both need the scroll-anchor path proven
 * first. So this never runs while the model is actually streaming
 * (`stream.status === "streaming"`) and never while a tool approval is pending.
 *
 * Note the state matrix (方案.md 已知限制 #51): `pauseSessionStream` writes
 * `status: "idle"` + live `requestId`, so awaiting-approval and a pending edit
 * apply are both `idle`.
 *
 * A pending tool approval is excluded by `pendingApprovalCount > 0`.
 * Waiting for an edit apply is represented as `idle` with a live requestId,
 * so it is not independently excluded here. `planHistoryTrim` still retains
 * the complete current turn from the latest user message to the history tail.
 */
export const reconcilePaginationAfterPersist = createAsyncThunk<
  boolean,
  { sessionId: string; savedRevision: number; totalHistoryCount?: number },
  ThunkApiType
>(
  "sessions/reconcilePaginationAfterPersist",
  async (
    { sessionId, savedRevision, totalHistoryCount },
    { getState, dispatch },
  ) => {
    const state = getState();
    const ui = state.config.config?.ui;
    if (!ui?.lazyLoadHistory) {
      return false;
    }
    const session = selectSessionById(state, sessionId);
    if (!session) {
      return false;
    }

    const persistence = session.persistence;
    // Stale or failed saves never trim (方案.md §七.6/§七.7): a newer revision
    // means content arrived while the request was in flight, so the response
    // describes an older window.
    if (!persistence || persistence.state !== "clean") {
      return false;
    }
    if (persistence.revision !== savedRevision) {
      return false;
    }
    if (!persistence.hasPersistedBaseline) {
      return false;
    }
    // 方案.md §九.4: the stream is only "idle" / "streaming" / "failed" —
    // `stopSessionStream` aborts the controller instead of writing an
    // "aborting" state, so "streaming" is the only unsafe value here.
    if (session.stream.status === "streaming") {
      return false;
    }
    if (session.pendingApprovalCount > 0) {
      return false;
    }
    if (session.pagination.loading) {
      return false;
    }
    if (session.pagination.persistPending) {
      return false;
    }

    // 方案.md §九.7: the save just rewrote the disk tail with this very window,
    // so the window's disk length is now `history.length`. `loadedDiskCount` is
    // still the PRE-save raw-page count (bubble merge makes it larger), and
    // `loadMoreHistory` passes it straight to `history/loadPage` as `offset` —
    // a stale value would skip items and leave a hole in the window. Only
    // reconcile when the response proves the head/window split.
    const loadedOffset = session.pagination.loadedOffset ?? 0;
    const diskSplitIsAuthoritative =
      totalHistoryCount !== undefined &&
      totalHistoryCount === loadedOffset + session.history.length;
    if (
      diskSplitIsAuthoritative &&
      session.pagination.truncated &&
      session.pagination.loadedDiskCount !== session.history.length
    ) {
      dispatch(
        setSessionPagination({
          sessionId,
          pagination: { loadedDiskCount: session.history.length },
        }),
      );
    }

    const plan = planHistoryTrim(
      session,
      getLazyLoadTrimLimit(ui.lazyLoadHistoryInitialCount),
      totalHistoryCount,
    );
    if (!plan) {
      return false;
    }

    dispatch(
      trimSessionHistoryWindow({
        sessionId,
        keepCount: plan.keepCount,
        removedDiskItems: plan.removedDiskItems,
        fullDiskItemCount: plan.fullDiskItemCount,
        retainedDiskItemCount: plan.retainedDiskItemCount,
      }),
    );
    return true;
  },
);
