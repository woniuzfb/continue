import { extractFirstTurnItems } from "core/util/firstTurn";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { getCurrentTurnItems } from "../slices/sessionHistory";
import type { SessionRuntimeState } from "../slices/sessionsSlice";

/**
 * 方案.md §十三 Phase 5：Local Provider 的请求历史构造。
 *
 * 每轮请求 = 磁盘首轮原始对话 + 当前完整回合。快速路径必须同时满足
 * `firstTurnItems` 非空、已有可靠磁盘基线、且保存未失败；否则回退
 * `loadFullHistory`（调用方执行后重建）。
 */

export type RequestHistoryMode = "full-history" | "first-turn-plus-current";

export type RequestHistoryPlan =
  | {
      kind: "ready";
      requestHistory: ChatHistoryItemWithMessageId[];
      mode: RequestHistoryMode;
    }
  | { kind: "needs-full-history" };

export function buildRequestHistoryForSession(
  session: SessionRuntimeState,
  options: { localConversation?: boolean } = {},
): RequestHistoryPlan {
  // 方案.md §十三.1: the reduced request is a Local Provider contract only.
  // Every other provider keeps the full history.
  if (!options.localConversation) {
    if (!session.pagination.truncated) {
      return {
        kind: "ready",
        requestHistory: session.history,
        mode: "full-history",
      };
    }
    return { kind: "needs-full-history" };
  }

  const currentTurnItems = getCurrentTurnItems(session.history);
  const firstTurnItems = session.firstTurnItems;

  const fastPathUsable =
    firstTurnItems.length > 0 &&
    !!session.persistence?.hasPersistedBaseline &&
    session.persistence?.state !== "failed";

  if (fastPathUsable) {
    // 首轮边界必须来自磁盘；若当前回合已经覆盖首轮（新会话第一轮），
    // 不能把 firstTurnItems 再拼一次（§十三.3）。
    const currentTurnStartsAtFirstTurn =
      currentTurnItems.length > 0 &&
      currentTurnItems[0].message.id === firstTurnItems[0]?.message.id;
    return {
      kind: "ready",
      requestHistory: currentTurnStartsAtFirstTurn
        ? currentTurnItems
        : [...firstTurnItems, ...currentTurnItems],
      mode: "first-turn-plus-current",
    };
  }

  // 回退：完整 history 就是权威请求历史（含首轮）。
  if (!session.pagination.truncated) {
    return {
      kind: "ready",
      requestHistory: session.history,
      mode: "full-history",
    };
  }

  return { kind: "needs-full-history" };
}

/** 完整 history 加载后的请求历史（含首轮），并顺带补 firstTurnItems。 */
export function requestHistoryFromFullHistory(
  history: ChatHistoryItemWithMessageId[],
): {
  requestHistory: ChatHistoryItemWithMessageId[];
  firstTurnItems: ChatHistoryItemWithMessageId[];
} {
  return {
    requestHistory: history,
    firstTurnItems: extractFirstTurnItems(history),
  };
}
