import { createAsyncThunk } from "@reduxjs/toolkit";
import { v4 as uuidv4 } from "uuid";

import {
  prependHistoryItems,
  setIsHistoryLoading,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

/**
 * 上滑到顶部时加载更早的历史消息。
 *
 * 分页模型说明：
 * - 磁盘上完整 history 总长 = total
 * - loadPage(offset, limit) 返回 history[total - offset - limit .. total - offset)
 * - 首次加载：offset=0, limit=N → 返回最新 N 条
 * - 此时"已加载条数" = N，"头部未加载条数" = total - N
 * - 加载更多：要取紧接着已加载部分之前的 pageSize 条
 *   → requestOffset = state.history.length（当前已加载条数）
 *   → 返回 history[total - loaded - pageSize .. total - loaded)
 * - prepend 后新的"头部未加载条数" = total - loaded - items.length
 */
export const loadMoreHistory = createAsyncThunk<void, void, ThunkApiType>(
  "session/loadMoreHistory",
  async (_, { getState, dispatch, extra }) => {
    const state = getState().session;

    // 防止重复加载
    if (state.isHistoryLoading) {
      return;
    }
    if (!state.hasMoreHistory) {
      return;
    }

    const pageSize = getState().config.config.ui?.lazyLoadHistoryPageSize ?? 4;
    const loadedCount = state.history.length;
    // loadPage 的 offset = 从末尾跳过的条数 = 当前已加载条数
    const requestOffset = loadedCount;

    dispatch(setIsHistoryLoading(true));

    try {
      const res = await extra.ideMessenger.request("history/loadPage", {
        id: state.id,
        offset: requestOffset,
        limit: pageSize,
      });

      if (res.status === "error") {
        console.warn("loadMoreHistory failed:", res.error);
        dispatch(setIsHistoryLoading(false));
        return;
      }

      const { items, hasMore, total } = res.content;

      // 竞态保护：IPC 往返期间若 history 已被完整加载（如用户发送消息触发
      // loadFullHistory），跳过 prepend。reducer 中也有同样守卫，这里提前
      // return 避免不必要的 dispatch。
      const currentState = getState().session;
      if (!currentState.historyTruncated) {
        dispatch(setIsHistoryLoading(false));
        return;
      }

      // 保留磁盘消息原 id（save 时已序列化），仅对缺失 id 的旧消息补新 uuid。
      // 与 loadFullHistory 保持一致，避免覆盖已持久化的 id 导致编辑器实例状态丢失。
      const itemsWithId = items.map((item) => ({
        ...item,
        message: {
          ...item.message,
          id: (item.message as { id?: string }).id ?? uuidv4(),
        },
      }));

      dispatch(
        prependHistoryItems({
          items: itemsWithId,
          hasMore,
          // prepend 后头部未加载条数 = total - 新的已加载总数
          newLoadedOffset: total - loadedCount - items.length,
          totalCount: total,
        }),
      );
    } catch (e) {
      console.warn("loadMoreHistory error:", e);
      dispatch(setIsHistoryLoading(false));
    }
  },
);
