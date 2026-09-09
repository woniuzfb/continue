import { createAsyncThunk } from "@reduxjs/toolkit";
import { LLMFullCompletionOptions } from "core";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import { selectSessionActiveTools } from "../selectors/sessionToolCalls";
import {
  selectSessionById,
  selectSessionChatModel,
} from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { setSessionContextMetrics } from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { buildRequestHistoryForSession } from "../util/requestHistory";
import { isLocalConversationModel } from "core/llm/localConversation";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

/**
 * Phase 1 session-scoped context metrics (方案.md §五.16).
 *
 * The legacy `compileChatForContextMetrics` can only measure the visible
 * session and always recompiles. This module owns the recompute gate: a
 * snapshot is reused only while its model identity, history revision and schema
 * version all still match, so switching tabs never triggers `llm/compileChat`.
 */

/** Bump when the snapshot shape or its meaning changes. */
export const CONTEXT_METRICS_SCHEMA_VERSION = 1;

/** Model the snapshot was taken with; empty when the session inherits one. */
export function sessionModelIdentity(
  state: Parameters<typeof selectSessionChatModel>[0],
  sessionId: string,
): string {
  return selectSessionChatModel(state, sessionId)?.title ?? "";
}

/**
 * True when the stored snapshot can no longer be trusted for this session
 * (方案.md §五.16 重算门禁): missing snapshot/meta, incompatible schema,
 * different model, or a history change since the snapshot.
 */
export function needsContextMetricsRecompute(
  state: Parameters<typeof selectSessionById>[0],
  sessionId: string,
): boolean {
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return false;
  }
  if (!session.contextMetrics) {
    return true;
  }
  const meta = session.contextMetricsMeta;
  if (!meta) {
    return true;
  }
  if (meta.schemaVersion !== CONTEXT_METRICS_SCHEMA_VERSION) {
    return true;
  }
  if (meta.modelIdentity !== sessionModelIdentity(state, sessionId)) {
    return true;
  }
  return meta.historyRevision !== session.historyRevision;
}

/**
 * Recompute one session's context metrics and store the snapshot plus its
 * identity. Lazy-loaded sessions read the full history from disk for the
 * compile only — the window state is left untouched (方案.md §五.12).
 */
export const compileSessionChatForContextMetrics = createAsyncThunk<
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

    // 方案.md §十三.8: the metrics path shares the request-history builder with
    // the send path, so token counts describe the same request.
    let historyForCompile: ChatHistoryItemWithMessageId[] = session.history;
    const plan = buildRequestHistoryForSession(session, {
      localConversation: isLocalConversationModel(selectedChatModel),
    });
    if (plan.kind === "ready") {
      historyForCompile = plan.requestHistory;
    } else if (session.pagination.truncated) {
      try {
        const result = await extra.ideMessenger.request("history/load", {
          id: sessionId,
        });
        if (result.status === "error") {
          console.warn(
            "compileSessionChatForContextMetrics: history/load failed",
            result.error,
          );
          return;
        }
        historyForCompile = result.content
          .history as ChatHistoryItemWithMessageId[];
      } catch (e) {
        console.warn(
          "compileSessionChatForContextMetrics: history/load failed",
          e,
        );
        return;
      }
    }

    let activeTools = selectSessionActiveTools(state, sessionId);
    if (selectedChatModel.toolOverrides?.length) {
      const { tools: overriddenTools, errors } = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      );
      activeTools = overriddenTools;
      for (const error of errors) {
        if (!error.fatal) {
          console.warn(`Tool override warning: ${error.message}`);
        }
      }
    }

    const useNativeTools = state.config.config.experimental
      ?.onlyUseSystemMessageTools
      ? false
      : modelSupportsNativeTools(selectedChatModel);
    const systemToolsFramework = !useNativeTools
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;

    let completionOptions: LLMFullCompletionOptions = {};
    if (useNativeTools && activeTools.length > 0) {
      completionOptions = { tools: activeTools };
    }

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

    const { messages } = constructMessages(
      historyForCompile,
      systemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
      systemToolsFramework,
    );

    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages,
      options: completionOptions,
    });
    if (precompiledRes.status === "error") {
      console.warn(
        "compileSessionChatForContextMetrics failed:",
        precompiledRes.error,
      );
      return;
    }

    const { didPrune, contextPercentage, inputTokens, contextLength } =
      precompiledRes.content;

    // Re-read: history may have moved while compiling. Store the revision the
    // snapshot actually describes so a stale result cannot look fresh.
    const current = selectSessionById(getState(), sessionId);
    if (!current) {
      return;
    }
    dispatch(
      setSessionContextMetrics({
        sessionId,
        metrics: { didPrune, contextPercentage, inputTokens, contextLength },
        meta: {
          modelIdentity: sessionModelIdentity(getState(), sessionId),
          historyRevision: current.historyRevision,
          schemaVersion: CONTEXT_METRICS_SCHEMA_VERSION,
        },
      }),
    );
  },
);
