import { createAsyncThunk } from "@reduxjs/toolkit";
import { selectSessionById } from "../selectors/sessions";
import {
  prependSessionHistory,
  setSessionHistory,
  setSessionHistoryLoading,
  setSessionPagination,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
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
