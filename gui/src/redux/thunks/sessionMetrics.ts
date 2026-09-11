import { createAsyncThunk } from "@reduxjs/toolkit";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import {
  selectSessionById,
  selectSessionChatModel,
} from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  beginSessionFullConversationMetricsMeasure,
  endSessionFullConversationMetricsMeasure,
  setSessionFullConversationMetrics,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "core/util/constructMessages";
import { isLocalConversationModel } from "core/llm/localConversation";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";
export { FULL_CONVERSATION_METRICS_SCHEMA_VERSION };
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  fullConversationConstructionIdentity,
  type FullConversationMetricsMeta,
  type FullConversationMetricsSnapshot,
} from "core/util/fullConversationMetrics";
import { resolveSessionMeasurementInputs } from "../util/sessionRequestOptions";
import {
  sameFullConversationMetricsEnvironment,
  type FullConversationMetricsEnvironment,
  type FullConversationMetricsFreshness,
} from "../util/fullConversationMetrics";
import type { SessionRuntimeState } from "../slices/sessionsSlice";
import type { RootState } from "../store";

/**
 * Session-scoped full-conversation metrics (方案.md §五.16).
 *
 * The legacy `compileChatForContextMetrics` can only measure the visible
 * session and always recompiles. This module owns the recompute gate: a
 * snapshot is reused only while its **complete identity** — conversation
 * revision, construction identity and schema version — still matches, so
 * switching tabs never triggers `llm/compileChat`.
 */

/**
 * The current construction identity (方案.md §五.16.2), computed from the same
 * resolved inputs the real compile uses, so the identity describes that prompt.
 * Returns `undefined` when the session is not loaded or has no model.
 */
export function sessionConstructionIdentity(
  state: RootState,
  sessionId: string,
): string | undefined {
  const session = selectSessionById(state, sessionId);
  const model = selectSessionChatModel(state, sessionId);
  if (!session || !model) {
    return undefined;
  }
  // Same single resolution the measurement request is built from, so the identity
  // always describes the environment the request asks Core to measure in.
  return fullConversationConstructionIdentity(
    resolveSessionMeasurementInputs({ state, session, model }).identityInputs,
  );
}

/**
 * True when the stored snapshot can no longer be trusted for this session
 * (方案.md §五.16.5): missing snapshot/meta, incompatible schema, an identity
 * that no longer matches the current construction environment, or a new
 * conversation revision. Comparing the whole identity is what makes the model
 * identity an input of it instead of a separate gate field.
 */
export function needsFullConversationMetricsRecompute(
  state: RootState,
  sessionId: string,
): boolean {
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return false;
  }
  if (!session.fullConversationMetrics) {
    return true;
  }
  const meta = session.fullConversationMetricsMeta;
  if (!meta) {
    return true;
  }
  if (meta.schemaVersion !== FULL_CONVERSATION_METRICS_SCHEMA_VERSION) {
    return true;
  }
  if (meta.conversationRevision !== session.conversationRevision) {
    return true;
  }
  const currentIdentity = sessionConstructionIdentity(state, sessionId);
  if (currentIdentity === undefined) {
    // No resolvable construction environment (no chat model): we cannot prove
    // the identity moved, and a measurement is impossible in that state anyway
    // (the compile thunk returns early), so the last-known snapshot stays
    // reusable — the same outcome as the previous `modelIdentity === ""`
    // comparison. `unavailable` is a Stage 2E freshness state, not this gate.
    return false;
  }
  return meta.constructionIdentity !== currentIdentity;
}

/** The identity a snapshot would carry if it were taken right now. */
export function currentFullConversationMetricsMeta(
  state: RootState,
  sessionId: string,
): FullConversationMetricsMeta | undefined {
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return undefined;
  }
  return {
    conversationRevision: session.conversationRevision,
    constructionIdentity: sessionConstructionIdentity(state, sessionId) ?? "",
    schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  };
}

/**
 * 当前构造环境指纹（方案.md §五.16.6）：只取引用与标量，**不**重算 canonical identity。
 *
 * 取哪些字段由「identity 的输入从哪来」决定（`resolveSessionMeasurementInputs`）：
 * `config.rules` / `config.tools` / `experimental.onlyUseSystemMessageTools` /
 * `ui.skipBaseSystemMessage` / 模型解析（`modelsByRole.chat` 与 `selectedModelByRole.chat`，
 * 由 `session.chatModelTitle` 决定走哪条）/ `ui.ruleSettings` / `ui.toolSettings` /
 * `ui.toolGroupSettings`，以及 session 自己的 `mode` 与 `hasReasoningEnabled`。
 *
 * 这里刻意**不用整个 config / ui 对象**做指纹：那样开关一个无关偏好（例如
 * `excludeThinkingFromCopy`、打开对话框）就会把快照判成 stale，让「只吃 fresh」的消费者
 * 无谓地停摆。反过来少取一个字段就会**多报 fresh** —— 所以新增构造输入时必须同时扩这里。
 */
export function currentFullConversationMetricsEnvironment(
  state: RootState,
  sessionId: string,
): FullConversationMetricsEnvironment | undefined {
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return undefined;
  }
  const config = state.config.config;
  return {
    rules: config.rules,
    tools: config.tools,
    experimental: config.experimental?.onlyUseSystemMessageTools,
    skipBaseSystemMessage: config.ui?.skipBaseSystemMessage ?? false,
    modelsByRole: config.modelsByRole?.chat,
    selectedModelByRole: config.selectedModelByRole?.chat,
    toolSettings: state.ui.toolSettings,
    toolGroupSettings: state.ui.toolGroupSettings,
    ruleSettings: state.ui.ruleSettings,
    chatModelTitle: session.chatModelTitle,
    mode: session.mode,
    hasReasoningEnabled: session.hasReasoningEnabled,
  };
}

/** ContextStatus / 自动决策读的唯一投影（方案.md §五.16.6）。 */
export type SessionFullConversationMetricsView = {
  metrics?: FullConversationMetricsSnapshot;
  freshness: FullConversationMetricsFreshness;
};

/**
 * 自动决策的唯一正确入口（方案.md §五.16.6）：**只吃 fresh**。
 *
 * ```text
 * fresh ⇒ 返回快照        —— 它描述的正是当前内容与当前构造环境
 * stale / measuring / unavailable ⇒ 返回 undefined
 * ```
 *
 * 「自动决策」指任何不需要用户点头就改变行为的判断（自动压缩阈值、自动重算触发条件
 * 之类）。显示路径**不**走这里：UI 可以继续显示 stale 的 last-known 数值。
 */
export function freshFullConversationMetrics(
  state: RootState,
  sessionId: string,
): FullConversationMetricsSnapshot | undefined {
  const view = selectFullConversationMetrics(state, sessionId);
  return view.freshness === "fresh" ? view.metrics : undefined;
}

/**
 * 一个 session 的完整会话指标 + **可信度**（方案.md §五.16.6）。
 *
 * ```text
 * 没有 metrics                        ⇒ measuring（正在飞行） / unavailable
 * 有 metrics 但身份不全 ⇒              measuring / stale
 *   身份 = meta 存在 ∧ schema 相符 ∧ conversationRevision 相符 ∧ 构造环境指纹相符
 * 身份齐全                            ⇒ fresh
 * ```
 *
 * 三条规矩：
 *
 * 1. `fresh` 只代表「这份数值描述的就是**当前**内容与**当前**构造环境」，它是唯一可以被
 *    自动决策（自动压缩阈值之类）当作权威的态；UI 可以继续显示 `stale` 的 last-known 值。
 * 2. `measuring` 优先于 `stale`：数值没到 ≠ 数值过期，消费者不该把飞行中的重算当成「已
 *    有一份旧值可用」。
 * 3. 判定完全基于**已存状态**，不重算 canonical identity —— 渲染路径上不能重跑系统消息
 *    渲染（流式期间每个 chunk 都会重新选择 state）。这里**信任**环境指纹与 meta 同源：
 *    两者由同一次 `setSessionFullConversationMetrics` 原子写入，而 canonical identity 的
 *    权威比较（含 string 相等）留在门禁 `needsFullConversationMetricsRecompute` 里。
 */
export function selectFullConversationMetricsFreshness(
  state: RootState,
  sessionId: string,
): FullConversationMetricsFreshness {
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return "unavailable";
  }
  const measuring = (session.fullConversationMetricsMeasuring ?? 0) > 0;
  const meta = session.fullConversationMetricsMeta;
  if (
    session.fullConversationMetrics &&
    meta &&
    meta.schemaVersion === FULL_CONVERSATION_METRICS_SCHEMA_VERSION &&
    meta.conversationRevision === session.conversationRevision &&
    sameFullConversationMetricsEnvironment(
      session.fullConversationMetricsEnvironment,
      currentFullConversationMetricsEnvironment(state, sessionId),
    )
  ) {
    return "fresh";
  }
  if (measuring) {
    return "measuring";
  }
  return session.fullConversationMetrics ? "stale" : "unavailable";
}

/** 只有数值的那一半（引用稳定 ⇒ React 消费者不会白重渲染）。 */
export function selectFullConversationMetricsSnapshot(
  state: RootState,
  sessionId: string,
): FullConversationMetricsSnapshot | undefined {
  return selectSessionById(state, sessionId)?.fullConversationMetrics;
}

/**
 * 数值 + 可信度的合并视图。**非 React 调用方**用这个；React 组件用
 * `useSessionFullConversationMetrics()`（它分别订阅两个稳定值再 `useMemo` 组装）——
 * 直接在这里返回一个新对象会让每次 dispatch 都产生新引用，导致无谓重渲染
 * （React-Redux 的 "returned a different result" 警告就是这么来的）。
 */
export function selectFullConversationMetrics(
  state: RootState,
  sessionId: string,
): SessionFullConversationMetricsView {
  return {
    metrics: selectFullConversationMetricsSnapshot(state, sessionId),
    freshness: selectFullConversationMetricsFreshness(state, sessionId),
  };
}

/**
 * Recompute one session's full-conversation metrics and store the snapshot plus
 * its identity. Lazy-loaded sessions read the full history from disk for the
 * compile only — the window state is left untouched (方案.md §五.12).
 */
/**
 * 方案.md §五.16.5/§九.7.1：只读重算完整会话指标（**不再**用发送路径的
 * `llm/compileChat`）。Core 从磁盘读完整 history，用请求里显式给出的构造与计量输入计量，
 * 不写盘、不裁剪、不抛 `Not enough context`。
 *
 * 接受条件（三项一起比，缺一不可）：返回的 `conversationRevision` 与当前一致、
 * `constructionIdentity` 与当前构造环境一致、`schemaVersion` 一致；reducer 还会再校验一次
 * revision。任何一项不匹配都**丢弃**结果 —— 宁可继续显示 last-known 数值，也不要一个
 * 看起来 fresh 的错值。
 */
export const measureFullConversationForMetrics = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/measureConversation",
  async ({ sessionId }, { getState, dispatch, extra }) => {
    const state = getState();
    const session = selectSessionById(state, sessionId);
    const selectedChatModel = selectSessionChatModel(state, sessionId);
    if (!session || !selectedChatModel || session.history.length === 0) {
      return;
    }
    const requestedMeta = currentFullConversationMetricsMeta(state, sessionId);
    if (!requestedMeta) {
      return;
    }
    const { request } = resolveSessionMeasurementInputs({
      state,
      session,
      model: selectedChatModel,
    });

    // 方案.md §五.16.6 `measuring`：数值还没回来，消费者不得把它当 fresh。
    dispatch(beginSessionFullConversationMetricsMeasure({ sessionId }));
    let response;
    try {
      response = await extra.ideMessenger.request(
        "history/measureConversation",
        {
          sessionId,
          measurement: { ...request, ...requestedMeta },
        },
      );
    } finally {
      dispatch(endSessionFullConversationMetricsMeasure({ sessionId }));
    }
    if (response.status === "error") {
      console.warn("measureFullConversationForMetrics failed:", response.error);
      return;
    }

    // The complete identity must still describe the conversation we measured.
    const currentMeta = currentFullConversationMetricsMeta(
      getState(),
      sessionId,
    );
    if (
      !currentMeta ||
      currentMeta.conversationRevision !==
        response.content.meta.conversationRevision ||
      currentMeta.constructionIdentity !==
        response.content.meta.constructionIdentity ||
      currentMeta.schemaVersion !== response.content.meta.schemaVersion
    ) {
      return;
    }
    const environment = currentFullConversationMetricsEnvironment(
      getState(),
      sessionId,
    );
    if (!environment) {
      return;
    }
    dispatch(
      setSessionFullConversationMetrics({
        sessionId,
        result: response.content,
        environment,
      }),
    );
  },
);
