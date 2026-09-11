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
  fullConversationMetricsFromCompileResult,
  type FullConversationMetricsMeta,
} from "../util/fullConversationMetrics";
import {
  buildFullConversationConstructionInputs,
  buildSessionCompletionOptions,
  resolveNativeTooling,
  resolveSessionActiveTools,
} from "../util/sessionRequestOptions";
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

function resolveConstructionInputs(
  state: RootState,
  session: SessionRuntimeState,
  model: NonNullable<ReturnType<typeof selectSessionChatModel>>,
) {
  const activeTools = resolveSessionActiveTools(state, session.id, model);
  const { useNativeTools, systemToolsFramework } = resolveNativeTooling(
    state,
    model,
    activeTools,
  );
  const completionOptions = buildSessionCompletionOptions({
    activeTools,
    useNativeTools,
    hasReasoningEnabled: session.hasReasoningEnabled,
    model,
  });
  const baseSystemMessage = state.config.config.ui?.skipBaseSystemMessage
    ? ""
    : getBaseSystemMessage(session.mode, model, activeTools);
  const systemMessage = systemToolsFramework
    ? addSystemMessageToolsToSystemMessage(
        systemToolsFramework,
        baseSystemMessage,
        activeTools,
      )
    : baseSystemMessage;
  return buildFullConversationConstructionInputs({
    state,
    session,
    model,
    activeTools,
    completionOptions,
    systemMessage,
  });
}

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
  return fullConversationConstructionIdentity(
    resolveConstructionInputs(state, session, model),
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
export const compileFullConversationForMetrics = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/compileMetrics",
  async ({ sessionId }, { getState, dispatch, extra }) => {
    const state = getState();
    const session = selectSessionById(state, sessionId);
    if (!session || session.history.length === 0) {
      return;
    }
    const selectedChatModel = selectSessionChatModel(state, sessionId);
    if (!selectedChatModel) {
      return;
    }
    // Capture the identity of the input we are about to measure (方案.md
    // §五.16.5): a stale async result must never be labelled with a newer
    // revision or a newer construction environment.
    const requestedMeta = currentFullConversationMetricsMeta(state, sessionId);
    if (!requestedMeta) {
      return;
    }

    // 方案.md §五.16: metrics describe the COMPLETE logical conversation. Do NOT
    // reuse the send-path request builder — for a Local Provider it returns the
    // reduced `firstTurnItems + currentTurnItems` payload, which is a different
    // quantity. Always measure the full history.
    let historyForCompile: ChatHistoryItemWithMessageId[] = session.history;
    const localConversation = isLocalConversationModel(selectedChatModel);
    if (session.pagination.truncated) {
      try {
        const result = await extra.ideMessenger.request("history/load", {
          id: sessionId,
        });
        if (result.status === "error") {
          console.warn(
            "compileFullConversationForMetrics: history/load failed",
            result.error,
          );
          return;
        }
        historyForCompile = result.content
          .history as ChatHistoryItemWithMessageId[];
      } catch (e) {
        console.warn(
          "compileFullConversationForMetrics: history/load failed",
          e,
        );
        return;
      }
    }

    // Same tool resolution and completion options as the real send
    // (方案.md §五.16): otherwise the metrics describe a different prompt.
    const activeTools = resolveSessionActiveTools(
      state,
      sessionId,
      selectedChatModel,
    );
    const { useNativeTools, systemToolsFramework } = resolveNativeTooling(
      state,
      selectedChatModel,
      activeTools,
    );
    const completionOptions = buildSessionCompletionOptions({
      activeTools,
      useNativeTools,
      hasReasoningEnabled: session.hasReasoningEnabled,
      model: selectedChatModel,
    });

    const baseSystemMessage = state.config.config.ui?.skipBaseSystemMessage
      ? ""
      : getBaseSystemMessage(session.mode, selectedChatModel, activeTools);
    const systemMessage = systemToolsFramework
      ? addSystemMessageToolsToSystemMessage(
          systemToolsFramework,
          baseSystemMessage,
          activeTools,
        )
      : baseSystemMessage;

    // The full history carries the summary carrier itself, so no override is
    // needed here (the override exists only for the reduced Local Provider send).
    const { messages } = constructMessages(
      historyForCompile,
      systemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
      systemToolsFramework,
    );

    // Temporary compatibility path (方案.md §五.16): during Step 1 the metrics
    // still go through compileChat, so an over-budget full conversation fails
    // with "Not enough context" and simply yields no new snapshot — the
    // last-known value is kept. The authoritative no-prune measurement
    // (`measureChatMessagesNoPrune`, `exceedsContext`) is a later Core stage.
    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages,
      options: completionOptions,
      protectedMessageIndexes: localConversation
        ? messages.map((_, index) => index)
        : undefined,
    });
    if (precompiledRes.status === "error") {
      console.warn(
        "compileFullConversationForMetrics failed:",
        precompiledRes.error,
      );
      return;
    }

    // Reject a result whose input was superseded while compiling: the complete
    // identity (revision + construction environment + schema) must still match,
    // otherwise the snapshot would claim a freshness it cannot prove.
    const currentMeta = currentFullConversationMetricsMeta(
      getState(),
      sessionId,
    );
    if (
      !currentMeta ||
      currentMeta.conversationRevision !== requestedMeta.conversationRevision ||
      currentMeta.constructionIdentity !== requestedMeta.constructionIdentity ||
      // Compared explicitly even though both sides use the same module constant
      // today: the contract is "the complete identity", not "two of three".
      currentMeta.schemaVersion !== requestedMeta.schemaVersion
    ) {
      return;
    }
    dispatch(
      setSessionFullConversationMetrics({
        sessionId,
        result: {
          metrics: fullConversationMetricsFromCompileResult(
            precompiledRes.content,
          ),
          meta: currentMeta,
        },
      }),
    );
  },
);
