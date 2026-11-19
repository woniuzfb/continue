import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { useStore } from "react-redux";
import type { RootState } from "../../redux/store";
import { loadMoreHistory as loadMoreHistoryThunk } from "../../redux/thunks/sessionPaging";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionHistory";
import {
  useSessionHasMoreHistory,
  useSessionIsHistoryLoading,
  useSessionIsStreaming,
} from "../../redux/selectors/sessionView";
import { setSessionHistoryKeepFloor } from "../../redux/slices/sessionsSlice";
import { recordSubmitLatency } from "../../util/submitLatency";

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
  const store = useStore<RootState>();
  const activeSessionId = useAppSelector(
    (state) => state.sessions.activeSessionId,
  );
  const hasMoreHistory = useSessionHasMoreHistory();
  const isHistoryLoading = useSessionIsHistoryLoading();
  const isStreaming = useSessionIsStreaming();

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

  /**
   * 方案.md §7.2.8: report how many trailing window rows this view needs to stay **visually
   * stable**, so the post-save trim releases only rows the user cannot see.
   *
   * Two parts, and the second one is why this is measured in pixels:
   *
   * 1. every row from the first one whose bottom edge is still below the container's top edge
   *    (the rows above it are off-screen and free to release);
   * 2. enough rows **above** that to leave one viewport of scroll room. Counting rows is not
   *    enough: a row whose content renders nothing (`tool`, an empty `thinking` row) still has a
   *    `data-message-id` wrapper and zero height, so four "buffer rows" can add zero pixels —
   *    and leaving the transcript with no scroll room is exactly the condition the
   *    fill-viewport pagination below reacts to, which prepends a page straight back (the
   *    reported "scrollbar suddenly grew, then went back"). The walk stops at the top of the
   *    window, which then reports the whole window and therefore trims nothing.
   *
   * Reports `0` when no row can be found: "nothing measurable on screen" must not keep rows
   * alive by accident. Dispatched on layout, scroll and resize, and the reducer ignores equal
   * values, so scroll traffic cannot turn into render traffic.
   */
  const reportVisibleRows = useCallback(() => {
    const elem = ref.current;
    if (
      !elem ||
      typeof elem.getBoundingClientRect !== "function" ||
      typeof elem.querySelectorAll !== "function"
    ) {
      // Measurement is best-effort: a container without layout cannot report visibility, and a
      // stale floor would pin memory for rows nobody can see. "Nothing measured" is 0.
      dispatch(setSessionHistoryKeepFloor({ sessionId, count: 0 }));
      return;
    }
    const containerTop = elem.getBoundingClientRect().top;
    const rows = Array.from(
      elem.querySelectorAll<HTMLElement>("[data-message-id]"),
    );
    const firstVisible = rows.findIndex(
      (node) => node.getBoundingClientRect().bottom > containerTop,
    );
    if (firstVisible < 0) {
      dispatch(setSessionHistoryKeepFloor({ sessionId, count: 0 }));
      return;
    }

    // One viewport of history above the visible band keeps the transcript scrollable, so a trim
    // can never hand the fill-viewport pagination the state it is written to remove.
    const bufferPx = elem.clientHeight;
    let keepFrom = firstVisible;
    let buffered = 0;
    while (keepFrom > 0 && buffered < bufferPx) {
      keepFrom -= 1;
      buffered += Math.max(0, rows[keepFrom].getBoundingClientRect().height);
    }

    const messageId = rows[keepFrom]?.dataset.messageId;
    const index =
      messageId === undefined
        ? -1
        : history.findIndex((item) => item.message.id === messageId);
    dispatch(
      setSessionHistoryKeepFloor({
        sessionId,
        count: index < 0 ? 0 : history.length - index,
      }),
    );
  }, [ref, history, sessionId, dispatch]);

  // Re-measure whenever the window changes (a new turn, a prepend, a trim) and once per paint
  // after layout settles — rows change height as markdown and code blocks render.
  const previousLengthRef = useRef(history.length);
  useLayoutEffect(() => {
    reportVisibleRows();
    const frame = requestAnimationFrame(reportVisibleRows);
    return () => cancelAnimationFrame(frame);
  }, [reportVisibleRows]);

  // 方案.md §7.2.8: a shrinking window is the one layout change at the end of a reply, and
  // whether the transcript still overflows afterwards decides whether the lazy-load machinery
  // reacts to it. Logged here (the only place with the container) and only when it shrank.
  useLayoutEffect(() => {
    const previous = previousLengthRef.current;
    previousLengthRef.current = history.length;
    if (history.length >= previous) {
      return;
    }
    const elem = ref.current;
    recordSubmitLatency({
      phase: "history-shrunk",
      sessionId,
      items: history.length,
      viewportPx: elem?.clientHeight,
      contentPx: elem?.scrollHeight,
    });
  }, [history.length, sessionId, ref]);

  // 方案.md §7.2.8: the view owns this measurement, so it also owns clearing it. When this view
  // stops showing this session, its number must not linger: a stale floor would hold rows alive
  // that nobody can see, and the save path deliberately never resolves the visible session
  // itself to find out (§五.20 — only the shell reads `activeSessionId`).
  useLayoutEffect(() => {
    return () => {
      dispatch(setSessionHistoryKeepFloor({ sessionId, count: 0 }));
    };
  }, [sessionId, dispatch]);

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
        reportVisibleRows();

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
          const prevLengthAtDispatch = latestHistoryLengthRef.current;
          void dispatch(
            loadMoreHistoryThunk({
              sessionId,
              requestGeneration:
                store.getState().sessions.sessionsById[sessionId]?.pagination
                  .requestGeneration ?? 0,
            }),
          ).finally(() => {
            const latestSession =
              store.getState().sessions.sessionsById[sessionId];
            if (
              isPrependingRef.current &&
              currentSessionIdRef.current === sessionId &&
              !latestSession?.pagination.loading &&
              (latestSession?.history.length ?? prevLengthAtDispatch) <=
                prevLengthAtDispatch
            ) {
              prependAnchorRef.current = null;
              isPrependingRef.current = false;
            }
          });
        }
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      // Measured before the early returns below: a resize (a taller row, a new chunk of
      // markdown) changes what is visible even when auto-bottom is skipped.
      reportVisibleRows();
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
    reportVisibleRows,
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

  // 视口填满检测：懒加载初始页可能不足一屏（如尾部恰好只有一轮的多气泡
  // 回复）。滚动容器无可滚动空间 → scroll 事件永不触发 → 顶部懒加载死锁：
  // 用户看到"只有最后一轮对话且无法上滑"。这里在每次挂载/prepend 后测量，
  // 未填满视口且还有历史时主动补页，直到内容可滚动或历史加载完。
  // 连续失败（loadPage 报错等导致 history 未增长）超过 3 次后放弃，避免
  // 无限重试；sessionId 切换或成功增长后重置。
  const fillViewportAttemptsRef = useRef(0);
  useEffect(() => {
    fillViewportAttemptsRef.current = 0;
  }, [sessionId]);
  // history 增长 = 上一次补页成功，重置失败计数（大视口可能需要连续多页
  // 才能填满；只有"连续 3 次都未增长"才视为失败放弃）。
  const lastFillCheckLengthRef = useRef(history.length);
  useEffect(() => {
    if (history.length > lastFillCheckLengthRef.current) {
      fillViewportAttemptsRef.current = 0;
    }
    lastFillCheckLengthRef.current = history.length;
  }, [history.length]);
  useEffect(() => {
    // 方案.md §九.2: a hidden tab must not fill its viewport or page in more
    // history; only the visible session may do that.
    if (activeSessionId !== sessionId) return;
    if (!hasMoreHistory || isHistoryLoading || isStreaming) return;
    if (fillViewportAttemptsRef.current >= 3) return;
    const prevLengthAtDispatch = history.length;
    // 双 rAF：等 React 渲染 + 行布局完成后测量才准确
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        const elem = ref.current;
        if (!elem) return;
        if (currentSessionIdRef.current !== sessionId) return;
        // isRestoring / isPrepending 检查放在帧回调内：mount 时 restore
        // 与 prepend 锚定（均为 layout effect）先置位再排队单帧 rAF 清位；
        // 本 effect 的双 rAF 排在它们之后，执行到此处时均已完成。若在 effect
        // body 检查，prepend 刚完成触发的本次重跑会被 isPrepending=true 挡死
        // 且之后无重跑信号，零高度页续页永远不会触发。
        if (isRestoringSessionScrollRef.current) return;
        if (isPrependingRef.current) return;
        // 两种死锁都需要主动补页：
        // 1. 不足一屏（scrollHeight <= clientHeight），无滚动条，scroll 事件永不触发；
        // 2. 用户已停在顶部（scrollTop < 50，例如刚 prepend 了一页全零高度的 tool 行
        //    或恢复到了顶部），浏览器对继续上滚不再派发 scroll 事件，必须续页直到
        //    顶部上方长出可滚动高度或历史加载完。
        const underfilled = elem.scrollHeight <= elem.clientHeight;
        const stuckAtTop =
          !underfilled &&
          userHasScrolled &&
          elem.scrollTop < 50 &&
          !suppressAutoScrollRef?.current;
        if (underfilled || stuckAtTop) {
          // The deadlock breaker firing. If this appears right after a `history-trim` or a
          // `history-shrunk`, the trim left the transcript with no scroll room — which is what
          // the keep floor's scroll buffer exists to prevent (方案.md §7.2.8).
          recordSubmitLatency({
            phase: "fill-viewport",
            sessionId,
            items: history.length,
            viewportPx: elem.clientHeight,
            contentPx: elem.scrollHeight,
          });
          fillViewportAttemptsRef.current += 1;
          isPrependingRef.current = true;
          prevScrollHeightRef.current = elem.scrollHeight;
          prevScrollTopRef.current = elem.scrollTop;
          if (stuckAtTop) {
            const containerTop = elem.getBoundingClientRect().top;
            const visibleMessage = Array.from(
              elem.querySelectorAll<HTMLElement>("[data-message-id]"),
            ).find(
              (node) => node.getBoundingClientRect().bottom > containerTop,
            );
            prependAnchorRef.current = visibleMessage
              ? {
                  messageId: visibleMessage.dataset.messageId!,
                  top: visibleMessage.getBoundingClientRect().top,
                }
              : null;
          } else {
            prependAnchorRef.current = null; // 顶部无可见锚，prepend 后走 scrollHeight-delta 恢复
          }
          void dispatch(
            loadMoreHistoryThunk({
              sessionId,
              requestGeneration:
                store.getState().sessions.sessionsById[sessionId]?.pagination
                  .requestGeneration ?? 0,
            }),
          ).finally(() => {
            const latestSession =
              store.getState().sessions.sessionsById[sessionId];
            if (
              isPrependingRef.current &&
              currentSessionIdRef.current === sessionId &&
              !latestSession?.pagination.loading &&
              (latestSession?.history.length ?? prevLengthAtDispatch) <=
                prevLengthAtDispatch
            ) {
              prependAnchorRef.current = null;
              isPrependingRef.current = false;
            }
          });
          // prepend 成功（history 增长）由上面的 effect 链路重置 isPrependingRef；
          // 这里只兜底失败场景：若干帧后 history 未增长则立即解锁并允许重试。
          setTimeout(() => {
            if (
              isPrependingRef.current &&
              latestHistoryLengthRef.current === prevLengthAtDispatch
            ) {
              isPrependingRef.current = false;
            }
          }, PREPEND_TIMEOUT_MS);
        }
      });
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      cancelAnimationFrame(innerRaf);
    };
    // history.length：prepend 成功后重测（循环填满视口）
    // isHistoryLoading：失败路径（loading true→false）也重测一次
    // activeSessionId：隐藏 tab 切换为激活态时补测一次
  }, [
    activeSessionId,
    history.length,
    hasMoreHistory,
    isHistoryLoading,
    isStreaming,
    userHasScrolled,
    sessionId,
    ref,
    dispatch,
    suppressAutoScrollRef,
  ]);
};
