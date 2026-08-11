import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { loadMoreHistory } from "../../redux/thunks/loadMoreHistory";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";

/**
 * Only reset scroll state when a new user message is added to the chat.
 * We don't want to auto-scroll on new tool response messages.
 */
function getNumUserMsgs(history: ChatHistoryItemWithMessageId[]) {
  return history.filter((msg) => msg.message.role === "user").length;
}

export const useAutoScroll = (
  ref: React.RefObject<HTMLDivElement>,
  history: ChatHistoryItemWithMessageId[],
  suppressAutoScrollRef?: React.MutableRefObject<boolean>,
) => {
  const dispatch = useAppDispatch();
  const hasMoreHistory = useAppSelector(
    (state) => state.session.hasMoreHistory,
  );
  const isHistoryLoading = useAppSelector(
    (state) => state.session.isHistoryLoading,
  );
  const isStreaming = useAppSelector((state) => state.session.isStreaming);

  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const numUserMsgs = useMemo(() => getNumUserMsgs(history), [history.length]);

  // prepend 锚定：记录 prepend 前的 scrollHeight，prepend 后恢复相对位置
  const isPrependingRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const prevScrollTopRef = useRef(0);
  // 记录上一次 history 长度，用于检测 prepend（长度增加且发生在头部）
  const prevHistoryLengthRef = useRef(history.length);
  // prepend 超时保护：loadMoreHistory 失败/返回空时 prependHistoryItems 不会
  // 被 dispatch，isPrependingRef 会卡在 true 永久阻塞后续加载。
  // 超时后强制清除。
  const prependTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const PREPEND_TIMEOUT_MS = 5000;
  // prepend 后跳过 auto-bottom：prepend 锚定恢复 scrollTop 后，紧随的
  // ResizeObserver 触发时若 userHasScrolled 状态尚未提交（React 批处理），
  // 会错误地 auto-bottom 拉到底部。设此标记跳过，等 scroll handler 更新
  // userHasScrolled 后再清除。
  const skipNextAutoBottomRef = useRef(false);

  // 新 user 消息出现时重置 auto-scroll。
  // 但 prepend 上滑加载的历史几乎必然含 user 消息（user/assistant 交替），
  // 会导致 numUserMsgs 增加 → setUserHasScrolled(false) → 触发 re-render →
  // ResizeObserver 重新 observe 时把 scrollTop 拉到底部，覆盖 prepend 锚定。
  // prepend 期间跳过重置即可。
  useEffect(() => {
    if (isPrependingRef.current || suppressAutoScrollRef?.current) return;
    setUserHasScrolled(false);
  }, [numUserMsgs]);

  // 当 isHistoryLoading 从 true 变 false 但 history 未增长（加载失败/空结果），
  // 清除 isPrependingRef 避免永久阻塞
  useEffect(() => {
    if (!isHistoryLoading && isPrependingRef.current) {
      // 给 prepend 检测 effect 一点时间处理正常情况
      if (prependTimeoutRef.current) {
        clearTimeout(prependTimeoutRef.current);
      }
      prependTimeoutRef.current = setTimeout(() => {
        if (isPrependingRef.current) {
          isPrependingRef.current = false;
        }
        prependTimeoutRef.current = null;
      }, PREPEND_TIMEOUT_MS);
    }
  }, [isHistoryLoading]);

  // prepend 检测：当 history 长度增加但不是新增 user 消息时（numUserMsgs 未变），
  // 说明是 prepend 了更早的历史，需要锚定滚动位置
  useEffect(() => {
    if (!ref.current) return;
    const prevLen = prevHistoryLengthRef.current;
    prevHistoryLengthRef.current = history.length;

    if (history.length > prevLen && isPrependingRef.current) {
      const elem = ref.current;
      const newScrollHeight = elem.scrollHeight;
      const delta = newScrollHeight - prevScrollHeightRef.current;
      elem.scrollTop = prevScrollTopRef.current + delta;
      // 双 ref 延迟清除：
      // - isPrependingRef 延迟到下一帧，防止紧随的 scroll handler rAF
      //   中顶部检测重复触发 loadMoreHistory
      // - skipNextAutoBottomRef 延迟到下一帧，防止紧随的 ResizeObserver
      //   回调（effect 重建）在 userHasScrolled 状态提交前 auto-bottom 拉到底部
      // 两者都在 rAF 中清除，此时 scroll handler 已有机会更新 userHasScrolled=true
      skipNextAutoBottomRef.current = true;
      requestAnimationFrame(() => {
        isPrependingRef.current = false;
        skipNextAutoBottomRef.current = false;
      });
      // 清除超时保护（正常 prepend 已完成）
      if (prependTimeoutRef.current) {
        clearTimeout(prependTimeoutRef.current);
        prependTimeoutRef.current = null;
      }
    }
  }, [history.length, ref]);

  useEffect(() => {
    if (!ref.current || history.length === 0) return;

    const handleScroll = () => {
      requestAnimationFrame(() => {
        const elem = ref.current;
        if (!elem) return;

        const isAtBottom =
          Math.abs(elem.scrollHeight - elem.scrollTop - elem.clientHeight) < 1;

        setUserHasScrolled(!isAtBottom);

        // 顶部检测：触发懒加载
        // streaming 期间禁止 prepend：core 在 stream 期间保存了 historyIndex 快照
        // （addContextItemsAtIndex），prepend 会改变 history.length 导致 index 错位
        if (
          elem.scrollTop < 50 &&
          hasMoreHistory &&
          !isHistoryLoading &&
          !isPrependingRef.current &&
          !isStreaming &&
          !suppressAutoScrollRef?.current
        ) {
          // 记录 prepend 前的滚动状态
          prevScrollHeightRef.current = elem.scrollHeight;
          prevScrollTopRef.current = elem.scrollTop;
          isPrependingRef.current = true;
          void dispatch(loadMoreHistory());
        }
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      const elem = ref.current;
      if (!elem || userHasScrolled) return;
      // External navigation (e.g. the "jump to previous message" button)
      // suppresses auto-bottom while it loads and scrolls.
      if (suppressAutoScrollRef?.current) return;
      // prepend 期间禁用 auto-bottom，否则会把用户拉到底部
      if (isPrependingRef.current) return;
      // prepend 刚完成时跳过 auto-bottom（userHasScrolled 状态可能尚未提交）
      if (skipNextAutoBottomRef.current) return;
      elem.scrollTop = elem.scrollHeight;
    });

    ref.current.addEventListener("scroll", handleScroll);

    Array.from(ref.current.children).forEach((child) => {
      resizeObserver.observe(child);
    });

    return () => {
      resizeObserver.disconnect();
      ref.current?.removeEventListener("scroll", handleScroll);
    };
  }, [
    ref,
    history.length,
    userHasScrolled,
    hasMoreHistory,
    isHistoryLoading,
    isStreaming,
    dispatch,
  ]);

  // 组件卸载时清理超时和 prepend 标记
  useEffect(() => {
    return () => {
      if (prependTimeoutRef.current) {
        clearTimeout(prependTimeoutRef.current);
      }
      isPrependingRef.current = false;
    };
  }, []);
};
