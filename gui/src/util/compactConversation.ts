import { useContext } from "react";
import { useStore } from "react-redux";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch } from "../redux/hooks";
import {
  deleteCompactionByMessageId,
  setCompactionLoadingByMessageId,
  updateHistoryItemByMessageId,
} from "../redux/slices/sessionsSlice";
import {
  loadFullHistory,
  resolveHistoryMutationTarget,
} from "../redux/thunks/sessionPaging";
import { enqueueSessionSave } from "../redux/thunks/sessionPersistence";
import { conversationVersionIntent } from "../redux/util/sessionSaveIntent";
import { windowToAbsoluteIndex } from "../redux/util/historyIndex";
import {
  carrierMessageIdOf,
  findGuiIndexContainingMessageId,
  windowHasUnsavedMerge,
} from "../redux/util/historyTarget";
import {
  selectSessionHistory,
  useSessionHistoryLoadedOffset,
  useSessionHistoryTruncated,
} from "../redux/selectors/sessionView";
import { useSessionId } from "../components/mainInput/TipTapEditor/SessionScope";
import type { ChatHistoryItemWithMessageId } from "../redux/slices/sessionHistory";
import type { AppDispatch, RootState } from "../redux/store";

/**
 * 方案.md §十二: identity first, index only when the mapping is provable.
 *
 * `index` is a **window** index — the coordinate the rendered items use.
 * `messageId` is an explicit identity, and it is the only way to address a
 * carrier that is not the item's own id (a merged bubble, whose own id is its
 * group's first assistant while its disk carrier is the group's last raw member).
 *
 * Both forms end up as the same thing internally: a carrier identity captured
 * **before any await**, then resolved on disk and in the window. A caller that
 * holds an id must not convert it into an index itself — that is exactly the
 * arithmetic the merged window breaks.
 */
export type HistoryMutationTarget = { index: number } | { messageId: string };

/**
 * Capture the click target's disk carrier **before** any await.
 *
 * `loadFullHistory` replaces `session.history` and a trim moves `loadedOffset`,
 * but the caller's index is relative to the window that was on screen when it
 * was passed (方案.md §十二). Identity survives both; an index does not.
 */
function captureCarrierId(
  history: ChatHistoryItemWithMessageId[],
  target: HistoryMutationTarget,
): string | undefined {
  if ("messageId" in target) {
    return target.messageId;
  }
  const item = history[target.index];
  return item ? carrierMessageIdOf(item) : undefined;
}

/**
 * The two coordinates of a captured carrier, computed on the **post-await**
 * window.
 *
 * Two regimes, and the difference is what makes an unsaved merge safe without
 * regressing the default configuration:
 *
 * - the window holds **no unsaved merge** ⇒ `loadedOffset + windowIndex` is a
 *   provable disk index (设计 §5) and the window is searched directly. No read is
 *   issued, so a lazy session whose ids were minted by `ensureMessageIds` and
 *   never persisted keeps behaving exactly as before;
 * - the window holds an **unsaved merged bubble** ⇒ one window item stands for
 *   several disk items, so arithmetic is meaningless there; resolve by identity
 *   on both arrays (`resolveHistoryMutationTarget` hydrates first when needed).
 *
 * `undefined` means abort: never guess an index, never operate on another
 * message.
 */
async function resolveMutationTarget(
  dispatch: AppDispatch,
  getState: () => RootState,
  sessionId: string,
  windowIndex: number | undefined,
  capturedOffset: number,
  historyTruncated: boolean,
  targetMessageId: string,
): Promise<{ diskIndex: number; guiIndex: number } | undefined> {
  const history = selectSessionHistory(getState(), sessionId);

  if (windowHasUnsavedMerge(history)) {
    return await dispatch(
      resolveHistoryMutationTarget({ sessionId, targetMessageId }),
    ).unwrap();
  }

  const guiIndex =
    windowIndex !== undefined
      ? windowToAbsoluteIndex(
          historyTruncated ? capturedOffset : 0,
          windowIndex,
        )
      : findGuiIndexContainingMessageId(history, targetMessageId);
  if (guiIndex < 0 || guiIndex >= history.length) {
    return undefined;
  }
  // 1:1 window ↔ disk, so the same index addresses both.
  return { diskIndex: guiIndex, guiIndex };
}

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const store = useStore<RootState>();
  // 方案.md §五.20: these hooks read the session from SessionScope, so a
  // compaction started in one tab can never target another tab's history.
  const sessionId = useSessionId();
  const historyTruncated = useSessionHistoryTruncated();
  const historyLoadedOffset = useSessionHistoryLoadedOffset() ?? 0;

  return async (target: HistoryMutationTarget) => {
    // Lazy-load compatibility (方案.md §十一): `conversation/compact` takes a
    // **disk** index, and the window index the caller passed is relative to the
    // loaded window. Capture the carrier first, then hydrate and resolve.
    const windowHistory = selectSessionHistory(store.getState(), sessionId);
    const targetMessageId = captureCarrierId(windowHistory, target);
    if (targetMessageId === undefined) {
      console.warn("compactConversation: 目标消息不在已加载的窗口中，已中止");
      return;
    }
    const merged = windowHasUnsavedMerge(windowHistory);

    if (!merged && historyTruncated) {
      // Compact is an explicit full-hydration operation (方案.md §十一). When the
      // window holds an unsaved merge the resolver below hydrates in the same
      // round trip, so this branch stays the only extra load.
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

    const resolved = await resolveMutationTarget(
      dispatch,
      store.getState,
      sessionId,
      "index" in target ? target.index : undefined,
      historyLoadedOffset,
      historyTruncated,
      targetMessageId,
    );
    if (!resolved) {
      console.warn(
        "compactConversation: 无法在磁盘上定位目标消息，已中止（不回退算术 index）",
      );
      return;
    }
    const { diskIndex, guiIndex } = resolved;

    // 守卫：不允许 compact 首轮对话（diskIndex=0）。
    // 使用磁盘 index 检查：懒加载条件下相对 index=0 可能对应磁盘 index>0，
    // 用相对 index 会误拦截。首轮对话在磁盘上始终是 0。
    if (diskIndex === 0) {
      console.warn(
        "compactConversation: 不允许 compact 首轮对话（diskIndex=0）",
      );
      return;
    }

    const messageId = selectSessionHistory(store.getState(), sessionId)[
      guiIndex
    ]?.message.id;
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
        index: diskIndex,
        sessionId: sessionId,
      });

      // compact 后不再 reload（reload 会破坏懒加载状态，且可能让 compact
      // 结果不在加载范围内）。改为直接在前端 state 上更新对应条目的
      // summary：Core 把摘要写到磁盘 index 的那一条，而窗口里承载它的条目
      // 就是 guiIndex（合并气泡时两者不是同一个下标）。
      if (result?.status === "success" && result.content) {
        const absoluteMessageId = selectSessionHistory(
          store.getState(),
          sessionId,
        )[guiIndex]?.message.id;
        if (absoluteMessageId) {
          dispatch(
            updateHistoryItemByMessageId({
              sessionId: sessionId,
              messageId: absoluteMessageId,
              updates: { conversationSummary: result.content },
            }),
          );
        }
        // 清除 stale 的 fullConversationMetrics（compact 改变了上下文结构）
        // updateHistoryItemByMessageId reducer 已自动清除它
        void dispatch(
          enqueueSessionSave({
            sessionId: sessionId,
            reason: "COMPACTION_CHANGED",
            // 摘要内容变化就是新的内容版本。
            measurementIntent: conversationVersionIntent(
              store.getState(),
              sessionId,
            ),
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

  /**
   * Identity only (方案.md §十二). Both callers already hold the id:
   *
   * - the real `ConversationSummary` renders `props.item`, so the item's own id
   *   is the addressed one;
   * - the synthetic separator holds `summary.sourceMessageId`, and the carrier it
   *   names sits outside the window — hence the full load below.
   *
   * Nothing here needs an index: the reducer is id-based, and the legacy
   * `sourceAbsoluteIndex` is not allowed to override a successful id match
   * (设计 §13 / test 13).
   */
  return async (messageId: string) => {
    if (!messageId) {
      console.warn("deleteCompaction: 缺少 messageId，已中止");
      return;
    }

    // 懒加载兼容：carrier 可能在窗口之外（合成分隔线），先加载完整 history
    // 才能按 id 命中它。id 在水合后依然稳定（窗口项是同一批对象引用）。
    if (historyTruncated) {
      try {
        await dispatch(loadFullHistory({ sessionId })).unwrap();
      } catch (e) {
        console.error("deleteCompaction: loadFullHistory failed, abort", e);
        return;
      }
    }

    // Update local state and save to persistence
    dispatch(deleteCompactionByMessageId({ sessionId, messageId }));
    void dispatch(
      enqueueSessionSave({
        sessionId,
        reason: "COMPACTION_DELETED",
        measurementIntent: conversationVersionIntent(
          store.getState(),
          sessionId,
        ),
      }),
    );
  };
};
