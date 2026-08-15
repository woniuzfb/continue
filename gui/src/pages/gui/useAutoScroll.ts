import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

type SavedScrollPosition = {
  scrollTop: number;
  wasAtBottom: boolean;
};

// Chat remains mounted while tabs switch, so the scroll container itself is
// shared. Keep viewport state outside React and key it by session instead of
// letting the previously visible session's scrollTop leak into the next one.
const MAX_SAVED_SESSION_SCROLL_POSITIONS = 20;
const sessionScrollPositions = new Map<string, SavedScrollPosition>();

function saveSessionScrollPosition(sessionId: string, elem: HTMLDivElement) {
  if (!sessionId) return;
  const wasAtBottom =
    Math.abs(elem.scrollHeight - elem.scrollTop - elem.clientHeight) < 1;
  if (sessionScrollPositions.has(sessionId)) {
    sessionScrollPositions.delete(sessionId);
  } else if (
    sessionScrollPositions.size >= MAX_SAVED_SESSION_SCROLL_POSITIONS
  ) {
    const oldestSessionId = sessionScrollPositions.keys().next().value;
    if (oldestSessionId !== undefined) {
      sessionScrollPositions.delete(oldestSessionId);
    }
  }
  sessionScrollPositions.set(sessionId, {
    scrollTop: elem.scrollTop,
    wasAtBottom,
  });
}

export const useAutoScroll = (
  ref: React.RefObject<HTMLDivElement>,
  history: ChatHistoryItemWithMessageId[],
  sessionId: string,
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
  // Preserve a real, already-rendered message as the prepend anchor. The
  // scrollHeight delta is only a fallback because asynchronous row layout can
  // continue changing the total height.
  const prependAnchorRef = useRef<{
    messageId: string;
    top: number;
  } | null>(null);
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
  // While restoring another session's viewport, ResizeObserver can fire for
  // every mounted row. It must not interpret the previous tab's state as a
  // request to jump this tab to the bottom.
  const isRestoringSessionScrollRef = useRef(false);
  const latestHistoryLengthRef = useRef(history.length);
  const currentSessionIdRef = useRef(sessionId);
  const sessionViewportTokenRef = useRef(0);
  latestHistoryLengthRef.current = history.length;

  // The scroll element is shared by every tab. Restore the incoming viewport
  // before paint and fence every deferred callback with a token so a rapid
  // A -> B -> A switch cannot let an older tab overwrite the current one.
  useLayoutEffect(() => {
    const elem = ref.current;
    if (!elem) return;

    const token = ++sessionViewportTokenRef.current;
    currentSessionIdRef.current = sessionId;
    const saved = sessionScrollPositions.get(sessionId);
    isRestoringSessionScrollRef.current = true;
    isPrependingRef.current = false;
    prependAnchorRef.current = null;
    skipNextAutoBottomRef.current = false;
    prevHistoryLengthRef.current = latestHistoryLengthRef.current;

    const isCurrentRestore = () =>
      sessionViewportTokenRef.current === token &&
      currentSessionIdRef.current === sessionId;

    const restore = () => {
      const currentElem = ref.current;
      if (!currentElem || !isCurrentRestore()) return;
      if (saved?.wasAtBottom) {
        currentElem.scrollTop = currentElem.scrollHeight;
      } else if (saved) {
        currentElem.scrollTop = Math.min(
          saved.scrollTop,
          Math.max(0, currentElem.scrollHeight - currentElem.clientHeight),
        );
      } else {
        // A session with no saved viewport follows the historical behavior:
        // show its latest message rather than retaining the previous tab's
        // raw scrollTop.
        currentElem.scrollTop = currentElem.scrollHeight;
      }
    };

    restore();
    setUserHasScrolled(saved ? !saved.wasAtBottom : false);
    const frame = requestAnimationFrame(() => {
      if (!isCurrentRestore()) return;
      restore();
      const currentElem = ref.current;
      if (currentElem) {
        saveSessionScrollPosition(sessionId, currentElem);
      }
      isRestoringSessionScrollRef.current = false;
    });

    return () => {
      cancelAnimationFrame(frame);
      if (sessionViewportTokenRef.current === token) {
        // Invalidate scroll/ResizeObserver callbacks queued by this tab before
        // the next tab's layout effect installs its own token.
        sessionViewportTokenRef.current++;
        isRestoringSessionScrollRef.current = false;
      }
    };
  }, [sessionId, ref]);

  // A user-count change caused by switching sessions is not a new message in
  // the current session. Skip that transition so the restored scrolled state
  // cannot be reset before ResizeObserver attaches to the incoming rows.
  const lastResetSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (lastResetSessionIdRef.current !== sessionId) {
      lastResetSessionIdRef.current = sessionId;
      return;
    }
    if (isPrependingRef.current || suppressAutoScrollRef?.current) return;
    setUserHasScrolled(false);
  }, [numUserMsgs, sessionId, suppressAutoScrollRef]);

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
          prependAnchorRef.current = null;
          isPrependingRef.current = false;
        }
        prependTimeoutRef.current = null;
      }, PREPEND_TIMEOUT_MS);
    }
  }, [isHistoryLoading]);

  // Restore the prepend anchor before paint. useEffect is visibly too late:
  // the browser paints the prepended rows at the old scrollTop and then jumps
  // when the passive effect applies the correction.
  useLayoutEffect(() => {
    const elem = ref.current;
    if (!elem) return;
    const prevLen = prevHistoryLengthRef.current;
    prevHistoryLengthRef.current = history.length;

    if (history.length > prevLen && isPrependingRef.current) {
      const anchor = prependAnchorRef.current;
      const anchorElement = anchor
        ? Array.from(
            elem.querySelectorAll<HTMLElement>("[data-message-id]"),
          ).find((node) => node.dataset.messageId === anchor.messageId)
        : null;

      if (anchor && anchorElement) {
        const currentTop = anchorElement.getBoundingClientRect().top;
        elem.scrollTop += currentTop - anchor.top;
      } else {
        // Fallback for legacy messages without a stable DOM id.
        const delta = elem.scrollHeight - prevScrollHeightRef.current;
        elem.scrollTop = prevScrollTopRef.current + delta;
      }

      // Re-anchor once more on the next frame to absorb asynchronous row
      // layout, but stop immediately if the anchor disappeared.
      skipNextAutoBottomRef.current = true;
      const prependSessionId = currentSessionIdRef.current;
      const prependSessionToken = sessionViewportTokenRef.current;
      requestAnimationFrame(() => {
        if (
          currentSessionIdRef.current !== prependSessionId ||
          sessionViewportTokenRef.current !== prependSessionToken
        ) {
          return;
        }
        const currentElem = ref.current;
        const currentAnchor = prependAnchorRef.current;
        if (currentElem && currentAnchor) {
          const node = Array.from(
            currentElem.querySelectorAll<HTMLElement>("[data-message-id]"),
          ).find(
            (candidate) =>
              candidate.dataset.messageId === currentAnchor.messageId,
          );
          if (node) {
            currentElem.scrollTop +=
              node.getBoundingClientRect().top - currentAnchor.top;
          }
        }
        prependAnchorRef.current = null;
        isPrependingRef.current = false;
        skipNextAutoBottomRef.current = false;
      });

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
        if (currentSessionIdRef.current !== sessionId) return;
        if (isRestoringSessionScrollRef.current) return;
        const elem = ref.current;
        if (!elem) return;

        const isAtBottom =
          Math.abs(elem.scrollHeight - elem.scrollTop - elem.clientHeight) < 1;

        saveSessionScrollPosition(sessionId, elem);
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
          // Record both a DOM anchor and the old scroll metrics. The anchor
          // keeps the same visible message at the same viewport position while
          // prepended rows are mounted and measured.
          prevScrollHeightRef.current = elem.scrollHeight;
          prevScrollTopRef.current = elem.scrollTop;
          const containerTop = elem.getBoundingClientRect().top;
          const visibleMessage = Array.from(
            elem.querySelectorAll<HTMLElement>("[data-message-id]"),
          ).find((node) => node.getBoundingClientRect().bottom > containerTop);
          prependAnchorRef.current = visibleMessage
            ? {
                messageId: visibleMessage.dataset.messageId!,
                top: visibleMessage.getBoundingClientRect().top,
              }
            : null;
          isPrependingRef.current = true;
          void dispatch(loadMoreHistory());
        }
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      const elem = ref.current;
      if (!elem || userHasScrolled) return;
      if (isRestoringSessionScrollRef.current) return;
      // External navigation (e.g. the "jump to previous message" button)
      // suppresses auto-bottom while it loads and scrolls.
      if (suppressAutoScrollRef?.current) return;
      // prepend 期间禁用 auto-bottom，否则会把用户拉到底部
      if (isPrependingRef.current) return;
      // prepend 刚完成时跳过 auto-bottom（userHasScrolled 状态可能尚未提交）
      if (skipNextAutoBottomRef.current) return;
      elem.scrollTop = elem.scrollHeight;
      saveSessionScrollPosition(sessionId, elem);
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
    sessionId,
    dispatch,
  ]);

  // 组件卸载时清理超时和 prepend 标记
  useEffect(() => {
    return () => {
      if (prependTimeoutRef.current) {
        clearTimeout(prependTimeoutRef.current);
      }
      prependAnchorRef.current = null;
      isPrependingRef.current = false;
    };
  }, []);
};
