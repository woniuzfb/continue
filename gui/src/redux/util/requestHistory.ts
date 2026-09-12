import { extractFirstTurnItems } from "core/util/firstTurn";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { getCurrentTurnItems } from "../slices/sessionHistory";
import type { SessionRuntimeState } from "../slices/sessionsSlice";

/**
 * 方案.md §十三 Phase 5：Local Provider 的请求历史构造。
 *
 * 每轮请求 = 磁盘首轮原始对话 + 当前完整回合。快速路径必须同时满足
 * `firstTurnItems` 非空、已有可靠磁盘基线、且保存未失败；否则回退完整历史
 * （§7.2.6：由 `loadFullRequestHistory` 以**只读快照**形式提供，窗口不动）。
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

/**
 * 方案.md §7.2.6：一次请求用的完整逻辑历史快照。
 *
 * 它是**只读**的：拿到它的调用方不得假设 `session.history` 也变成了完整会话 —— 可见窗口按 §十一
 * 保持 lazy，快照只在本次请求内有效。
 */
export interface FullRequestHistorySnapshot {
  /** 完整逻辑历史（冻结的磁盘头 + 运行时尾），可直接作为模型请求历史。 */
  history: ChatHistoryItemWithMessageId[];
  /** 磁盘首轮缓存（`setSessionFirstTurn` 用；可能为空）。 */
  firstTurnItems: ChatHistoryItemWithMessageId[];
  /**
   * 校验通过时仍然生效的对话摘要。Local Provider 的缩减请求没有摘要载体，需要显式注入
   * （§十三.0），所以快照把它一起带出来，避免调用方回头去读一个更早捕获的 state。
   */
  latestConversationSummary?: SessionRuntimeState["latestConversationSummary"];
}

/** 完整 history 加载后的请求历史（含首轮），并顺带补 firstTurnItems。 */
export function requestHistoryFromFullHistory(
  history: ChatHistoryItemWithMessageId[],
  options: {
    latestConversationSummary?: SessionRuntimeState["latestConversationSummary"];
  } = {},
): FullRequestHistorySnapshot {
  return {
    history,
    firstTurnItems: extractFirstTurnItems(history),
    latestConversationSummary: options.latestConversationSummary,
  };
}
