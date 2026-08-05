import { useContext } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import {
  setCompactionLoading,
  deleteCompaction,
  updateHistoryItemAtIndex,
} from "../redux/slices/sessionSlice";
import { saveCurrentSession } from "../redux/thunks/session";
import { loadFullHistory } from "../redux/thunks/loadFullHistory";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useAppSelector((state) => state.session.id);
  const historyTruncated = useAppSelector(
    (state) => state.session.historyTruncated,
  );
  const historyLoadedOffset = useAppSelector(
    (state) => state.session.historyLoadedOffset ?? 0,
  );

  return async (index: number) => {
    if (!currentSessionId) {
      return;
    }

    // 懒加载兼容：前端 index 是基于部分 history 的相对位置，
    // 后端在完整 history 上切片会错位。先加载完整 history，
    // 把相对 index 偏移为完整 history 中的绝对 index。
    let absoluteIndex = index;
    if (historyTruncated) {
      absoluteIndex = index + historyLoadedOffset;
      try {
        await dispatch(loadFullHistory()).unwrap();
      } catch (e) {
        console.error(
          "compactConversation: loadFullHistory failed, abort compact",
          e,
        );
        return;
      }
    }

    // 守卫：不允许 compact 首轮对话（absoluteIndex=0）。
    // 使用绝对 index 检查：懒加载条件下相对 index=0 可能对应绝对 index>0，
    // 用相对 index 会误拦截。首轮对话的绝对 index 始终为 0。
    if (absoluteIndex === 0) {
      console.warn(
        "compactConversation: 不允许 compact 首轮对话（absoluteIndex=0）",
      );
      return;
    }

    try {
      dispatch(setCompactionLoading({ index, loading: true }));

      const result = await ideMessenger.request("conversation/compact", {
        index: absoluteIndex,
        sessionId: currentSessionId,
      });

      // compact 后不再 reload（reload 会破坏懒加载状态，且可能让 compact
      // 结果不在加载范围内）。改为直接在前端 state 上更新对应 index 的
      // summary。此时 history 已完整加载，absoluteIndex 即前端 state index。
      // 后端返回 content 即为生成的 summary 文本。
      if (result?.status === "success" && result.content) {
        dispatch(
          updateHistoryItemAtIndex({
            index: absoluteIndex,
            updates: {
              conversationSummary: result.content,
            },
          }),
        );
        // 清除 stale 的 contextMetrics（compact 改变了上下文结构）
        // updateHistoryItemAtIndex reducer 已自动清除 contextMetrics
      }
    } catch (error) {
      console.error("Error compacting conversation:", error);
    } finally {
      dispatch(setCompactionLoading({ index, loading: false }));
    }
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();
  const historyTruncated = useAppSelector(
    (state) => state.session.historyTruncated,
  );
  const historyLoadedOffset = useAppSelector(
    (state) => state.session.historyLoadedOffset ?? 0,
  );

  return async (index: number) => {
    // 懒加载兼容：前端 index 是基于部分 history 的相对位置，
    // deleteCompaction reducer 直接按 index 操作 state.history，
    // 需偏移为完整 history 中的绝对 index。先加载完整 history。
    let absoluteIndex = index;
    if (historyTruncated) {
      absoluteIndex = index + historyLoadedOffset;
      try {
        await dispatch(loadFullHistory()).unwrap();
      } catch (e) {
        console.error("deleteCompaction: loadFullHistory failed, abort", e);
        return;
      }
    }

    // 守卫：不允许操作首轮对话（absoluteIndex=0）。
    // 与 compact 一致，使用绝对 index 检查，保护首轮对话不被修改。
    if (absoluteIndex === 0) {
      console.warn("deleteCompaction: 不允许操作首轮对话（absoluteIndex=0）");
      return;
    }

    // Update local state and save to persistence
    dispatch(deleteCompaction(absoluteIndex));
    dispatch(
      saveCurrentSession({
        openNewSession: false,
      }),
    );
  };
};
