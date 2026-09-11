import type { RootState } from "../store";
import type { SessionSaveMeasurementIntent } from "./sessionSaveQueue";

/**
 * 方案.md §五.16.4「保存边界（按显式开关，不按 reason）」：计量意图的构造与判定。
 *
 * 三个概念必须分清：
 *
 * ```text
 * conversationRevision   完整逻辑会话内容版本（reducer 推进）
 * measurementIntent      调用方对「本次保存是否建立了新内容版本」的表态
 * save reason            诊断/日志/测试描述，**不参与**计量决策
 * ```
 *
 * `buildSessionPayload` 只会校验 intent 里的 revision 与 session 当前值一致；不一致
 * （保存期间内容又变了）就不携带计量，磁盘 metrics 保持原状并继续显示为 stale。
 */

/** 本次保存不建立新的内容版本：只保存，不计量。 */
export const NO_MEASUREMENT: SessionSaveMeasurementIntent = { kind: "none" };

/**
 * 「本次 mutation 之后的完整会话内容版本」——给**已经推进了 revision 的调用方**用。
 *
 * 调用点必须在 mutation **之后**调用它（在同一个 thunk 里紧跟 dispatch），否则会把
 * 旧版本当成新版本；session 不存在时退化为 `none`（没有可计量的内容版本）。
 */
export function conversationVersionIntent(
  state: RootState,
  sessionId: string,
): SessionSaveMeasurementIntent {
  const revision = state.sessions.sessionsById[sessionId]?.conversationRevision;
  return revision === undefined
    ? NO_MEASUREMENT
    : { kind: "conversation-version", conversationRevision: revision };
}

/**
 * 合并保存队列 coalescing 时的两个意图。
 *
 * 队列每个 session 只有一个 pending 槽位：入队是 last-write-wins，但**计量义务不能被
 * 后来的簿记保存吞掉**。可达场景：
 *
 * ```text
 * save A 正在运行
 * → terminal save B 入队 conversation-version(12)
 * → 一个 checkpoint/bookkeeping save C 入队 none     ← 覆盖了 B 的槽位
 * → A 结束，循环消费 C ⇒ terminal 建立的权威计量被静默丢弃
 * ```
 *
 * 规则（最新 intent 优先，但 none 不会抹掉尚未兑现的 conversation-version）：
 *
 * ```text
 * next 是 conversation-version  ⇒ 用 next（更新的快照已包含旧内容）
 * next 是 none 且 previous 是 conversation-version ⇒ 保留 previous
 * 两个都是 none                  ⇒ none
 * ```
 *
 * 保留的旧 intent 仍要过 `buildSessionPayload` 的当前 revision 校验：内容已经推进到更
 * 新版本时不携带计量（磁盘 metrics 保持原值、继续 stale），因此不会把旧版本计成 fresh。
 */
export function mergeMeasurementIntent(
  previous: SessionSaveMeasurementIntent,
  next: SessionSaveMeasurementIntent,
): SessionSaveMeasurementIntent {
  if (next.kind === "conversation-version") {
    return next;
  }
  return previous;
}

/**
 * 比较一次边界前后的 revision：**只有真的推进了**才算建立了新的内容版本。
 *
 * 这是聊天终态（`finishSessionStreamWorkflow`）使用的判据 —— 「无输出的终态不 commit」
 * 在 Step 1 由 `stream.hasConversationMutation` 决定，这里再把结果落到计量意图上，
 * 于是 reason 是 `STREAM_COMPLETED` 还是 `STREAM_FAILED` 都不影响计量。
 */
export function intentFromRevisionDelta(
  before: number | undefined,
  after: number | undefined,
): SessionSaveMeasurementIntent {
  if (before === undefined || after === undefined || after !== before + 1) {
    return NO_MEASUREMENT;
  }
  return { kind: "conversation-version", conversationRevision: after };
}
