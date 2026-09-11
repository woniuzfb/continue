import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  LLMFullCompletionOptions,
  ModelDescription,
  PromptLog,
  Tool,
} from "core";
import { getRuleId } from "core/llm/rules/getSystemMessageWithRules";
import { ToCoreProtocol } from "core/protocol";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { interceptSystemToolCalls } from "core/tools/systemMessageTools/interceptSystemToolCalls";
import { v4 as uuidv4 } from "uuid";
import {
  selectSessionActiveTools,
  selectSessionPendingToolCalls,
  selectSessionToolCalls,
} from "../selectors/sessionToolCalls";
import { recordSubmitLatency } from "../../util/submitLatency";
import {
  buildSessionCompletionOptions,
  resolveNativeTooling,
  resolveSessionActiveTools,
} from "../util/sessionRequestOptions";
import {
  selectSessionById,
  selectSessionChatModel,
} from "../selectors/sessions";
import type { SessionRuntimeState } from "../slices/sessionsSlice";
import {
  applySessionStreamUpdate,
  beginSessionStream,
  finishSessionStream,
  commitSessionConversationTurn,
  pauseSessionStream,
  setSessionFirstTurn,
  setSessionInlineError,
  setSessionStreamError,
  updateHistoryItemByMessageId,
} from "../slices/sessionsSlice";
import {
  AppThunkDispatch,
  RootState,
  ThunkApiType,
  ThunkExtrasType,
} from "../store";
import { constructMessages } from "core/util/constructMessages";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";
import {
  applySessionToolCallUpdate,
  findSessionToolCallTarget,
} from "../util/sessionToolCallWrites";
import { evaluateSessionToolPolicies } from "./evaluateToolPolicies";
import { preprocessSessionToolCalls } from "./preprocessToolCallArgs";
import { enqueueSessionSave } from "./sessionPersistence";
import {
  NO_MEASUREMENT,
  intentFromRevisionDelta,
} from "../util/sessionSaveIntent";
import { scheduleMessageIdMigrationIfSafe } from "./sessionMessageIdMigration";
import {
  buildRequestHistoryForSession,
  requestHistoryFromFullHistory,
} from "../util/requestHistory";
import { generateSessionTitle } from "./sessionTitle";
import { loadFullHistory } from "./sessionPaging";
import { isLocalConversationModel } from "core/llm/localConversation";
import {
  approveToolCalls,
  continueToolLoop,
  registerSessionStreamRunner,
} from "./sessionTools";

/**
 * Phase 1 session stream ownership (方案.md §五.7/§五.10, §六 `sessionStreams.ts`).
 *
 * One model request per `requestId`, created here with its own
 * `AbortController`, written straight into `sessionsById[sessionId]`. There is
 * no LRU routing and no active-session read: a background tab streams exactly
 * like the visible one.
 *
 * The request stays live while the session is awaiting tool approval, so the
 * tool loop can continue it. Terminal states save immediately.
 */

export type SessionStreamTerminalStatus = "completed" | "aborted" | "failed";

export type SessionStreamRunInput = {
  sessionId: string;
  /**
   * Predecessor request. A continuation (tool loop, retry) only starts while
   * this is still the live request, otherwise the turn was superseded.
   */
  requestId?: string;
  depth?: number;
  legacySlashCommandData?: ToCoreProtocol["llm/streamChat"][0]["legacySlashCommandData"];
};

type StreamApi = {
  dispatch: AppThunkDispatch;
  getState: () => RootState;
  ideMessenger: ThunkExtrasType["ideMessenger"];
};

/** Guard against an endless tool loop (legacy had the same cap in tests). */
const MAX_TOOL_LOOP_DEPTH = 50;

/** Regular checkpoints need both gates; boundary events bypass them (§七.3). */
const CHECKPOINT_MIN_INTERVAL_MS = 5000;
const CHECKPOINT_MIN_CHARS = 4096;

type CheckpointBaseline = { at: number; chars: number };
const checkpointBaselines = new Map<string, CheckpointBaseline>();

/** Test helper: drop the per-session checkpoint baselines. */
export function resetSessionStreamCheckpoints(): void {
  checkpointBaselines.clear();
}

function isLiveRequest(
  state: RootState,
  sessionId: string,
  requestId: string,
): boolean {
  return state.sessions.sessionsById[sessionId]?.stream.requestId === requestId;
}

/**
 * Cheap content size used only by the checkpoint cost gate. The exact value
 * does not matter, only that it grows with new content.
 */
function sessionContentLength(session: SessionRuntimeState): number {
  let total = 0;
  for (const item of session.history) {
    const content = item.message.content;
    total +=
      typeof content === "string"
        ? content.length
        : JSON.stringify(content).length;
    for (const toolCallState of item.toolCallStates ?? []) {
      total += toolCallState.output?.length ?? 0;
    }
  }
  return total;
}

// ── Terminal / checkpoint workflow ──────────────────────────────────────

/**
 * Terminal save (方案.md §七.4). A stale terminal never touches a newer
 * request: the reducer guard is repeated here so no save is enqueued either.
 */
export const finishSessionStreamWorkflow = createAsyncThunk<
  boolean,
  {
    sessionId: string;
    requestId: string;
    status: SessionStreamTerminalStatus;
    reason?: string;
  },
  ThunkApiType
>(
  "sessions/finishStreamWorkflow",
  async ({ sessionId, requestId, status, reason }, { dispatch, getState }) => {
    if (!isLiveRequest(getState(), sessionId, requestId)) {
      return false;
    }
    // Chat terminal: commit the completed logical turn (方案.md §五.16.4) while
    // the request is still live, then end the stream lifecycle. Non-chat
    // streams (edit mode) never call this and must not invalidate the metrics.
    //
    // 方案.md §五.16.4「按显式开关，不按 reason」：计量意图来自**这次 commit 是否真的
    // 建立了新内容版本**（Step 1 的 `hasConversationMutation` 门禁已经在 reducer 里决定
    // 了这一点）。无输出 terminal（首 token 前 Stop/Failure、out-of-context）不推进
    // revision，于是这里得到 `none`，磁盘 metrics 原样保留。
    const terminalStartedAt = performance.now();
    const revisionBefore = selectSessionById(
      getState(),
      sessionId,
    )?.conversationRevision;
    dispatch(
      commitSessionConversationTurn({
        sessionId,
        requestId,
        terminalStatus: status,
      }),
    );
    const revisionAfter = selectSessionById(
      getState(),
      sessionId,
    )?.conversationRevision;
    recordSubmitLatency({
      phase: "terminal-commit",
      sessionId,
      durationMs: performance.now() - terminalStartedAt,
      ok: true,
    });
    dispatch(finishSessionStream({ sessionId, requestId, status }));
    checkpointBaselines.delete(sessionId);
    const beforeTerminalSave = performance.now();
    await dispatch(
      enqueueSessionSave({
        sessionId,
        reason: reason ?? `STREAM_${status.toUpperCase()}`,
        measurementIntent: intentFromRevisionDelta(
          revisionBefore,
          revisionAfter,
        ),
      }),
    );
    // P4a: legacy message ID migration, "stream terminal" trigger. The save
    // above also kicks it, but no trigger is load-bearing on its own — each one
    // just says "this session may now be safe" and the schedule thunk decides.
    recordSubmitLatency({
      phase: "terminal-save-enqueue",
      sessionId,
      durationMs: performance.now() - beforeTerminalSave,
    });
    void dispatch(scheduleMessageIdMigrationIfSafe({ sessionId }));
    return true;
  },
);

/**
 * Checkpoint save. `force` is for the immediate boundaries of §七.2
 * (tool generated / awaiting approval / tool result / abort / failure /
 * terminal); regular checkpoints must clear the 5s + 4096 char gate.
 */
export const checkpointSessionStream = createAsyncThunk<
  boolean,
  { sessionId: string; requestId: string; reason: string; force?: boolean },
  ThunkApiType
>(
  "sessions/checkpointStream",
  async ({ sessionId, requestId, reason, force }, { dispatch, getState }) => {
    const state = getState();
    const session = selectSessionById(state, sessionId);
    if (!session || session.stream.requestId !== requestId) {
      return false;
    }
    const chars = sessionContentLength(session);
    if (!force) {
      // No baseline yet means everything is new: the character gate decides.
      const baseline = checkpointBaselines.get(sessionId) ?? {
        at: 0,
        chars: 0,
      };
      const now = Date.now();
      if (
        now - baseline.at < CHECKPOINT_MIN_INTERVAL_MS ||
        chars - baseline.chars < CHECKPOINT_MIN_CHARS
      ) {
        return false;
      }
    }
    checkpointBaselines.set(sessionId, { at: Date.now(), chars });
    await dispatch(
      enqueueSessionSave({
        sessionId,
        reason: `STREAM_CHECKPOINT:${reason}`,
        // 流式中途的簿记保存：本回合的内容版本边界仍是 terminal。
        measurementIntent: NO_MEASUREMENT,
      }),
    );
    return true;
  },
);

/**
 * Stop button (方案.md §五.11): stops only the named session's named request.
 * A stale `requestId` can never stop a newer stream.
 */
export const stopSessionStream = createAsyncThunk<
  boolean,
  { sessionId: string; requestId: string },
  ThunkApiType
>("sessions/stopStream", async ({ sessionId, requestId }, { getState }) => {
  const session = selectSessionById(getState(), sessionId);
  if (!session || session.stream.requestId !== requestId) {
    return false;
  }
  // Aborting the controller is an effect, not a store write: the stream loop
  // observes `signal.aborted` and finalizes the terminal state itself.
  session.stream.aborter?.abort();
  return true;
});

/**
 * Stop-button entry point (方案.md §五.11): global active UI may resolve the
 * active session, but the stop itself is still session+request scoped. A stale
 * requestId can never stop a newer stream.
 */
export const stopActiveSessionStream = createAsyncThunk<
  boolean,
  void,
  ThunkApiType
>("sessions/stopActiveStream", async (_, { dispatch, getState }) => {
  const state = getState();
  const sessionId = state.sessions.activeSessionId;
  const requestId = sessionId
    ? state.sessions.sessionsById[sessionId]?.stream.requestId
    : undefined;
  if (!sessionId || !requestId) {
    return false;
  }
  return (await dispatch(
    stopSessionStream({ sessionId, requestId }),
  ).unwrap()) as boolean;
});

// ── Model request ───────────────────────────────────────────────────────

type TurnContext = {
  sessionId: string;
  requestId: string;
  depth: number;
  aborter: AbortController;
  legacySlashCommandData?: ToCoreProtocol["llm/streamChat"][0]["legacySlashCommandData"];
};

type TurnOutcome =
  /** No further model call belongs to this turn. */
  | { kind: "terminal" }
  /** This turn already wrote its terminal state. */
  | { kind: "already-finished" }
  /** The tool loop owns the rest of the turn. */
  | { kind: "handoff" }
  /** Waiting for the user to approve or reject. */
  | { kind: "awaiting-approval" }
  /** Session or request disappeared. */
  | { kind: "gone" };

async function runToolSequence(
  api: StreamApi,
  ctx: TurnContext,
): Promise<TurnOutcome> {
  const { dispatch, getState } = api;
  const { sessionId, requestId, depth } = ctx;

  const state = getState();
  const session = selectSessionById(state, sessionId);
  if (!session || session.stream.requestId !== requestId) {
    return { kind: "gone" };
  }

  const allToolCalls = selectSessionToolCalls(state, sessionId);
  if (allToolCalls.length === 0) {
    return { kind: "terminal" };
  }

  // 1. Mark generating calls as generated and attach the tool definition.
  const configTools = state.config.config.tools;
  for (const toolCallState of allToolCalls) {
    if (toolCallState.status !== "generating") {
      continue;
    }
    const target = findSessionToolCallTarget(
      session.history,
      toolCallState.toolCallId,
    );
    if (!target) {
      continue;
    }
    const tool = configTools.find(
      (candidate) =>
        candidate.function.name === toolCallState.toolCall.function.name,
    );
    applySessionToolCallUpdate(api, {
      sessionId,
      messageId: target.assistantItem.message.id,
      toolCallId: toolCallState.toolCallId,
      patch: { status: "generated", ...(tool ? { tool } : {}) },
    });
  }
  void dispatch(
    checkpointSessionStream({
      sessionId,
      requestId,
      reason: "TOOL_CALLS_GENERATED",
      force: true,
    }),
  );

  // 2. Pre-process args before evaluating policies.
  const toPreprocess = selectSessionPendingToolCalls(getState(), sessionId);
  if (toPreprocess.length > 0) {
    await preprocessSessionToolCalls(api, {
      sessionId,
      toolCallIds: toPreprocess.map((state) => state.toolCallId),
    });
  }

  // 3. Arg-dependent policy evaluation.
  const pending = selectSessionPendingToolCalls(getState(), sessionId);
  if (pending.length > 0) {
    const currentState = getState();
    const activeTools = selectSessionActiveTools(currentState, sessionId);
    const policies = await evaluateSessionToolPolicies(api, {
      sessionId,
      toolCallIds: pending.map((state) => state.toolCallId),
      activeTools,
      toolPolicies: currentState.ui.toolSettings,
    });

    const autoApproved = policies
      .filter(({ policy }) => policy === "allowedWithoutPermission")
      .map(({ toolCallState }) => toolCallState.toolCallId);
    const needsApproval = policies.filter(
      ({ policy }) => policy === "allowedWithPermission",
    );

    if (needsApproval.length > 0) {
      // Built-in readonly calls still run while siblings await approval.
      const readonlyAutoApproved = autoApproved.filter((toolCallId) => {
        const toolCallState = pending.find(
          (state) => state.toolCallId === toolCallId,
        );
        return (
          toolCallState?.tool?.group === BUILT_IN_GROUP_NAME &&
          toolCallState?.tool?.readonly
        );
      });
      if (readonlyAutoApproved.length > 0) {
        void dispatch(
          approveToolCalls({
            sessionId,
            requestId,
            toolCallIds: readonlyAutoApproved,
            depth: depth + 1,
          }),
        );
      }
      void dispatch(
        checkpointSessionStream({
          sessionId,
          requestId,
          reason: "TOOL_CALL_AWAITING_APPROVAL",
          force: true,
        }),
      );
      // Waiting for the user: not streaming, but the request stays live.
      dispatch(pauseSessionStream({ sessionId, requestId }));
      return { kind: "awaiting-approval" };
    }

    if (autoApproved.length > 0) {
      // The tool loop executes the calls and continues the turn itself.
      void dispatch(
        approveToolCalls({
          sessionId,
          requestId,
          toolCallIds: autoApproved,
          depth: depth + 1,
        }),
      );
      return { kind: "handoff" };
    }
  }

  // 4. Every call is already terminal (invalid args, disabled policy, ...):
  // record the results and let the loop continue through continueToolLoop.
  const remaining = selectSessionPendingToolCalls(getState(), sessionId);
  if (remaining.length === 0) {
    const lastToolCallId = selectSessionToolCalls(getState(), sessionId).at(
      -1,
    )?.toolCallId;
    if (lastToolCallId) {
      void dispatch(
        continueToolLoop({
          sessionId,
          requestId,
          toolCallId: lastToolCallId,
          depth: depth + 1,
        }),
      );
      return { kind: "handoff" };
    }
  }

  return { kind: "terminal" };
}

function attachPromptLog(
  api: StreamApi,
  sessionId: string,
  promptLog: PromptLog,
): void {
  const session = selectSessionById(api.getState(), sessionId);
  const lastItem = session?.history.at(-1);
  if (!session || !lastItem) {
    return;
  }
  api.dispatch(
    updateHistoryItemByMessageId({
      sessionId,
      messageId: lastItem.message.id,
      updates: {
        promptLogs: lastItem.promptLogs
          ? [...lastItem.promptLogs, promptLog]
          : [promptLog],
        // Reasoning never streams its closing tag on request completion.
        ...(lastItem.reasoning?.active
          ? {
              reasoning: {
                ...lastItem.reasoning,
                active: false,
                endAt: Date.now(),
              },
            }
          : {}),
      },
    }),
  );
}

async function streamModelTurn(
  api: StreamApi,
  ctx: TurnContext,
): Promise<TurnOutcome> {
  const { dispatch, getState, ideMessenger } = api;
  const { sessionId, requestId, aborter } = ctx;

  const state = getState();
  const session = selectSessionById(state, sessionId);
  if (!session || session.stream.requestId !== requestId) {
    return { kind: "gone" };
  }

  const selectedChatModel = selectSessionChatModel(state, sessionId);
  if (!selectedChatModel) {
    dispatch(
      setSessionStreamError({
        sessionId,
        requestId,
        error: "No chat model selected",
      }),
    );
    await dispatch(
      finishSessionStreamWorkflow({
        sessionId,
        requestId,
        status: "failed",
        reason: "STREAM_FAILED",
      }),
    );
    return { kind: "already-finished" };
  }

  // Tools: model-level overrides win over the global list. The metrics
  // compile uses the same helpers so both requests are identical (方案.md §五.16).
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

  // 方案.md §十三 Phase 5: Local Provider fast path = first turn + current
  // turn; anything else falls back to the full history (loading it first when
  // the window is truncated).
  let historyForRequest = session.history;
  const localConversation = isLocalConversationModel(selectedChatModel);
  const plan = buildRequestHistoryForSession(session, { localConversation });
  if (plan.kind === "ready") {
    historyForRequest = plan.requestHistory;
  } else {
    await dispatch(loadFullHistory({ sessionId })).unwrap();
    const full = selectSessionById(getState(), sessionId);
    if (!full) {
      return { kind: "gone" };
    }
    const rebuilt = requestHistoryFromFullHistory(full.history);
    historyForRequest = rebuilt.requestHistory;
    dispatch(
      setSessionFirstTurn({
        sessionId,
        firstTurnItems: rebuilt.firstTurnItems,
      }),
    );
  }

  // 方案.md §五.16: only the complete logical conversation may update the
  // context metrics. Use the builder's explicit mode, never
  // `pagination.truncated`: the Local Provider fast path returns a reduced
  // request even when the window is not truncated yet (firstTurnItems + a
  // reliable baseline is enough). The reduced compile still drives the actual
  // send / prune / out-of-context decision.
  const requestUsesReducedHistory =
    plan.kind === "ready" && plan.mode === "first-turn-plus-current";

  const { messages, appliedRules, appliedRulesSourceMessageId } =
    constructMessages(
      historyForRequest,
      systemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
      systemToolsFramework,
      // The reduced request has no summary carrier, so the compact summary is
      // injected explicitly (方案.md §十三.0).
      localConversation
        ? {
            conversationSummaryOverride:
              session.latestConversationSummary?.content,
          }
        : undefined,
    );

  if (appliedRulesSourceMessageId) {
    dispatch(
      updateHistoryItemByMessageId({
        sessionId,
        messageId: appliedRulesSourceMessageId,
        updates: { appliedRules },
      }),
    );
  }

  dispatch(setSessionInlineError({ sessionId, error: undefined }));

  // 方案.md §十四: a Local Provider request has no prunable middle history, so
  // every message (system + first turn + current turn) is protected and an
  // over-budget request fails as out-of-context instead of silently dropping
  // the first turn.
  const protectedMessageIndexes = localConversation
    ? messages.map((_, index) => index)
    : undefined;

  const precompiledRes = await ideMessenger.request("llm/compileChat", {
    messages,
    options: completionOptions,
    protectedMessageIndexes,
  });

  if (precompiledRes.status === "error") {
    if (precompiledRes.error.includes("Not enough context")) {
      dispatch(setSessionInlineError({ sessionId, error: "out-of-context" }));
      await dispatch(
        finishSessionStreamWorkflow({
          sessionId,
          requestId,
          status: "aborted",
          reason: "STREAM_OUT_OF_CONTEXT",
        }),
      );
      return { kind: "already-finished" };
    }
    throw new Error(precompiledRes.error);
  }

  const {
    compiledChatMessages,
    didPrune,
    contextPercentage,
    inputTokens,
    contextLength,
  } = precompiledRes.content;

  // 指标不再由发送路径的 compile 结果写入（方案.md §五.16.4）：完整会话指标的权威来源
  // 是 `history/save` 锁内计量（terminal 后立即保存并回传 Result）与只读的
  // `history/measureConversation`。这里的 compile 结果只服务发送决策。
  try {
    let gen = ideMessenger.llmStreamChat(
      {
        completionOptions,
        title: selectedChatModel.title,
        messages: compiledChatMessages,
        legacySlashCommandData: ctx.legacySlashCommandData,
        messageOptions: { precompiled: true },
      },
      aborter.signal,
    );
    if (systemToolsFramework && activeTools.length > 0) {
      gen = interceptSystemToolCalls(gen, aborter, systemToolsFramework);
    }

    let next = await gen.next();
    while (!next.done) {
      if (
        aborter.signal.aborted ||
        !isLiveRequest(getState(), sessionId, requestId)
      ) {
        break;
      }
      dispatch(
        applySessionStreamUpdate({
          sessionId,
          requestId,
          messages: next.value,
        }),
      );
      next = await gen.next();
    }

    if (next.done && next.value) {
      attachPromptLog(api, sessionId, next.value);
      try {
        ideMessenger.post("devdata/log", {
          name: "chatInteraction",
          data: {
            prompt: next.value.prompt ?? "",
            completion: next.value.completion,
            modelProvider: selectedChatModel.underlyingProviderName,
            modelName: selectedChatModel.title,
            modelTitle: selectedChatModel.title,
            sessionId,
            ...(activeTools.length > 0 && {
              tools: activeTools.map((tool: Tool) => tool.function.name),
            }),
            ...(appliedRules.length > 0 && {
              rules: appliedRules.map((rule) => ({
                id: getRuleId(rule),
                slug: rule.slug,
              })),
            }),
          },
        });
      } catch (e) {
        console.error("Failed to send dev data interaction log", e);
      }
    }
  } catch (e) {
    const toolCallsToCancel = selectSessionToolCalls(getState(), sessionId);
    const isPrematureClose =
      e instanceof Error && e.message.toLowerCase().includes("premature close");
    if (toolCallsToCancel.length > 0 && isPrematureClose) {
      // Streamed arguments were cut off: close the calls so the loop can
      // continue instead of leaving them generating forever.
      for (const toolCallState of toolCallsToCancel) {
        const target = findSessionToolCallTarget(
          getState().sessions.sessionsById[sessionId]?.history ?? [],
          toolCallState.toolCallId,
        );
        if (!target) {
          continue;
        }
        applySessionToolCallUpdate(api, {
          sessionId,
          messageId: target.assistantItem.message.id,
          toolCallId: toolCallState.toolCallId,
          patch: {
            status: "errored",
            output: [
              {
                name: "Tool Call Error",
                description: "Premature Close",
                content: `"Premature Close" error: this tool call was aborted mid-stream because the arguments took too long to stream or there were network issues. Please re-attempt by breaking the operation into smaller chunks or trying something else`,
                icon: "problems",
              },
            ],
          },
        });
      }
    } else {
      throw e;
    }
  }

  if (aborter.signal.aborted) {
    await dispatch(
      finishSessionStreamWorkflow({
        sessionId,
        requestId,
        status: "aborted",
        reason: "STREAM_ABORTED",
      }),
    );
    return { kind: "already-finished" };
  }

  return runToolSequence(api, ctx);
}

// ── Entry points ────────────────────────────────────────────────────────

async function runSessionStreamImpl(
  input: SessionStreamRunInput,
  api: StreamApi,
): Promise<void> {
  const { dispatch, getState } = api;
  const { sessionId, depth = 0 } = input;

  // Self-register the continuation used by sessionTools.continueToolLoop. The
  // dispatch captured here is the store dispatch, so no module-level import of
  // the store (and no import cycle) is needed. Re-registering is idempotent.
  registerSessionStreamRunner(async ({ sessionId, requestId, depth }) => {
    await api.dispatch(runSessionStream({ sessionId, requestId, depth }));
  });

  const session = selectSessionById(getState(), sessionId);
  if (!session) {
    return;
  }
  // A continuation must still own the live request.
  if (input.requestId && session.stream.requestId !== input.requestId) {
    return;
  }
  if (depth > MAX_TOOL_LOOP_DEPTH) {
    throw new Error(`Max session tool loop depth of ${MAX_TOOL_LOOP_DEPTH}`);
  }

  const requestId = uuidv4();
  const aborter = new AbortController();
  dispatch(beginSessionStream({ sessionId, requestId, aborter }));
  checkpointBaselines.set(sessionId, {
    at: Date.now(),
    chars: sessionContentLength(session),
  });

  const ctx: TurnContext = {
    sessionId,
    requestId,
    depth,
    aborter,
    legacySlashCommandData: input.legacySlashCommandData,
  };

  let outcome: TurnOutcome;
  try {
    outcome = await streamModelTurn(api, ctx);
  } catch (e) {
    await dispatch(
      finishSessionStreamWorkflow({
        sessionId,
        requestId,
        status: "failed",
        reason: "STREAM_FAILED",
      }),
    );
    throw e;
  }

  if (outcome.kind === "terminal") {
    await dispatch(
      finishSessionStreamWorkflow({
        sessionId,
        requestId,
        status: "completed",
        reason: "STREAM_COMPLETED",
      }),
    );
    // Title generation is a post-terminal side effect (方案.md §七.9): the reply
    // is already saved, and a failure never blocks it.
    void dispatch(generateSessionTitle({ sessionId }));
  }
}

export const runSessionStream = createAsyncThunk<
  void,
  SessionStreamRunInput,
  ThunkApiType
>("sessions/runStream", async (input, { dispatch, extra, getState }) =>
  runSessionStreamImpl(input, {
    dispatch,
    getState,
    ideMessenger: extra.ideMessenger,
  }),
);
