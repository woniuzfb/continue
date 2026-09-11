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
