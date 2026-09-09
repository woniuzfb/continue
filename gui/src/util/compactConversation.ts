import { useContext } from "react";
import { useStore } from "react-redux";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch } from "../redux/hooks";
import {
  deleteCompactionByMessageId,
  setCompactionLoadingByMessageId,
  updateHistoryItemByMessageId,
} from "../redux/slices/sessionsSlice";
import { loadFullHistory } from "../redux/thunks/sessionPaging";
import { enqueueSessionSave } from "../redux/thunks/sessionPersistence";
import {
  selectSessionHistory,
  useSessionHistoryLoadedOffset,
  useSessionHistoryTruncated,
} from "../redux/selectors/sessionView";
import { useSessionId } from "../components/mainInput/TipTapEditor/SessionScope";
import type { RootState } from "../redux/store";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const store = useStore<RootState>();
  // 方案.md §五.20: these hooks read the session from SessionScope, so a
  // compaction started in one tab can never target another tab's history.
  const sessionId = useSessionId();
  const historyTruncated = useSessionHistoryTruncated();
  const historyLoadedOffset = useSessionHistoryLoadedOffset() ?? 0;

  return async (index: number) => {
    // 懒加载兼容：前端 index 是基于部分 history 的相对位置，
    // 后端在完整 history 上切片会错位。先加载完整 history，
    // 把相对 index 偏移为完整 history 中的绝对 index。
    let absoluteIndex = index;
    if (historyTruncated) {
      absoluteIndex = index + historyLoadedOffset;
      try {
        await dispatch(loadFullHistory({ sessionId })).unwrap();
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

    // 必须在 await 之后重新读取 history：loadFullHistory 完成后 store 里才是
    // 完整 history，而渲染期捕获的数组仍是截断窗口，用绝对 index 去索引会
    // 取到错误/undefined 的消息，导致 compact 结果写不回 state。
    const messageId = selectSessionHistory(store.getState(), sessionId)[index]
      ?.message.id;
    try {
      if (messageId) {
        dispatch(
          setCompactionLoadingByMessageId({
            sessionId: sessionId,
            messageId,
            loading: true,
          }),
        );
      }

      const result = await ideMessenger.request("conversation/compact", {
        index: absoluteIndex,
        sessionId: sessionId,
      });

      // compact 后不再 reload（reload 会破坏懒加载状态，且可能让 compact
      // 结果不在加载范围内）。改为直接在前端 state 上更新对应 index 的
      // summary。此时 history 已完整加载，absoluteIndex 即前端 state index。
      // 后端返回 content 即为生成的 summary 文本。
      if (result?.status === "success" && result.content) {
        const absoluteMessageId = selectSessionHistory(
          store.getState(),
          sessionId,
        )[absoluteIndex]?.message.id;
        if (absoluteMessageId) {
          dispatch(
            updateHistoryItemByMessageId({
              sessionId: sessionId,
              messageId: absoluteMessageId,
              updates: { conversationSummary: result.content },
            }),
          );
        }
        // 清除 stale 的 contextMetrics（compact 改变了上下文结构）
        // updateHistoryItemByMessageId reducer 已自动清除 contextMetrics
        void dispatch(
          enqueueSessionSave({
            sessionId: sessionId,
            reason: "COMPACTION_CHANGED",
          }),
        );
      }
    } catch (error) {
      console.error("Error compacting conversation:", error);
    } finally {
      if (messageId) {
        dispatch(
          setCompactionLoadingByMessageId({
            sessionId: sessionId,
            messageId,
            loading: false,
          }),
        );
      }
    }
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const sessionId = useSessionId();
  const historyTruncated = useSessionHistoryTruncated();
  const historyLoadedOffset = useSessionHistoryLoadedOffset() ?? 0;

  /**
   * `index` is relative to the loaded window by default (that is what the
   * rendered items use). The synthetic separator knows the absolute index of a
   * carrier that is *outside* the window, so it passes `{ absolute: true }`.
   */
  return async (index: number, options?: { absolute?: boolean }) => {
    // 懒加载兼容：前端 index 是基于部分 history 的相对位置，
    // deleteCompaction reducer 直接按 index 操作 state.history，
    // 需偏移为完整 history 中的绝对 index。先加载完整 history。
    let absoluteIndex = options?.absolute ? index : index + historyLoadedOffset;
    if (historyTruncated) {
      try {
        await dispatch(loadFullHistory({ sessionId })).unwrap();
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
    const messageId = selectSessionHistory(store.getState(), sessionId)[
      absoluteIndex
    ]?.message.id;
    if (messageId) {
      dispatch(deleteCompactionByMessageId({ sessionId, messageId }));
    }
    void dispatch(
      enqueueSessionSave({ sessionId, reason: "COMPACTION_DELETED" }),
    );
  };
};
