import { createAsyncThunk } from "@reduxjs/toolkit";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import {
  selectSessionById,
  selectSessionChatModel,
} from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { setSessionFullConversationMetrics } from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "core/util/constructMessages";
import { isLocalConversationModel } from "core/llm/localConversation";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";
export { FULL_CONVERSATION_METRICS_SCHEMA_VERSION };
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  fullConversationConstructionIdentity,
  type FullConversationMetricsMeta,
} from "core/util/fullConversationMetrics";
import { resolveSessionMeasurementInputs } from "../util/sessionRequestOptions";
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

    const response = await extra.ideMessenger.request(
      "history/measureConversation",
      {
        sessionId,
        measurement: { ...request, ...requestedMeta },
      },
    );
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
    dispatch(
      setSessionFullConversationMetrics({
        sessionId,
        result: response.content,
      }),
    );
  },
);
