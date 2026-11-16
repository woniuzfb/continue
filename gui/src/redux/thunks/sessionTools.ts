import { createAsyncThunk } from "@reduxjs/toolkit";
import { ChatMessage, ContextItem, McpUiState, ToolCallState } from "core";
import { CLIENT_TOOLS_IMPLS } from "core/tools/builtIn";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import { renderContextItems } from "core/util/messageContent";
import { callClientTool } from "../../util/clientTools/callClientTool";
import { selectSessionActiveTools } from "../selectors/sessionToolCalls";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  applySessionStreamUpdate,
  pauseSessionStream,
  type SessionRuntimeState,
} from "../slices/sessionsSlice";
import { AppThunkDispatch, ThunkApiType, ThunkExtrasType } from "../store";
import { findChatHistoryItemByToolCallId, logToolUsage } from "../util";
import {
  applySessionToolCallUpdate,
  findSessionToolCallTarget,
  type SessionToolCallTarget,
} from "../util/sessionToolCallWrites";
import {
  evaluateToolPolicy,
  policyViolationContextItem,
} from "./evaluateToolPolicies";
import { enqueueSessionSave } from "./sessionPersistence";
import { NO_MEASUREMENT } from "../util/sessionSaveIntent";

/**
 * Phase 1 tool loop (方案.md §五.20, §六 `sessionTools.ts`).
 *
 * Every entry point carries `sessionId`, `requestId` and `toolCallId`:
 *
 * - `sessionId` decides which runtime owns the tool state. The active session
 *   is never read, so a background tab can approve/execute/reject its own
 *   calls while another tab is visible.
 * - `requestId` is the turn identity (`§五.7`). It spans chunk, tool,
 *   approval, result, checkpoint and terminal, so it is still live while the
 *   session is awaiting approval. An action whose `requestId` no longer
 *   matches `sessionsById[sessionId].stream.requestId` is stale — e.g. after a
 *   restart — and is ignored instead of executing an old request.
 * - `toolCallId` isolates parallel tool calls: one approval never decides for
 *   a sibling call, and `pendingApprovalCount` stays derived from history.
 *
 * The tool loop stops at the tool result. Continuing the turn is the stream
 * runner's job; see `registerSessionStreamRunner` below.
 */

export type SessionToolSkipReason =
  | "session-missing"
  | "stale-request"
  | "tool-call-missing"
  | "not-awaiting-approval"
  | "pending-tool-calls";

export type SessionToolOutcome = {
  /**
   * `approved` / `rejected`: this action settled the call.
   * `errored`: the call was settled with a recorded failure.
   * `waiting`: the sequence still has non-terminal sibling calls.
   * `completed`: the sequence is terminal and the loop may continue.
   * `skipped`: nothing was written; see `reason`.
   */
  status:
    | "approved"
    | "rejected"
    | "errored"
    | "waiting"
    | "completed"
    | "skipped";
  toolCallId: string;
  reason?: SessionToolSkipReason;
  errorMessage?: string;
  /** `continueToolLoop` only: the stream runner was asked to continue. */
  continuationRequested?: boolean;
};

/**
 * The session-scoped model request loop lives in `sessionStreams.ts`. It
 * registers itself here so the tool loop can continue the turn without a
 * circular import — and without ever falling back to the legacy
 * active-session stream thunks.
 *
 * Until it is registered, `continueToolLoop` records the tool result and stops:
 * the tool sequence is complete, but no next model call is started.
 */
export type SessionStreamRunner = (input: {
  sessionId: string;
  requestId: string;
  depth: number;
}) => Promise<unknown>;

let sessionStreamRunner: SessionStreamRunner | undefined;

export function registerSessionStreamRunner(runner: SessionStreamRunner): void {
  sessionStreamRunner = runner;
}

/** Test helper: drop the registered runner. */
export function resetSessionStreamRunner(): void {
  sessionStreamRunner = undefined;
}

// ── Target resolution ───────────────────────────────────────────────────

type ToolCallTarget = SessionToolCallTarget & {
  session: SessionRuntimeState;
};

type TargetGuard =
  | { ok: true; target: ToolCallTarget }
  | { ok: false; reason: SessionToolSkipReason };

function locateToolCall(
  session: SessionRuntimeState,
  toolCallId: string,
): ToolCallTarget | undefined {
  const target = findSessionToolCallTarget(session.history, toolCallId);
  return target ? { session, ...target } : undefined;
}

/**
 * A tool call is awaiting approval while its status is still `generated`
 * (`allowedWithPermission` calls are never auto-executed and never
 * auto-rejected). `disabled` / auto-approved calls never reach this state.
 */
function guardAwaitingToolCall(
  state: ThunkApiType["state"],
  input: { sessionId: string; requestId: string; toolCallId: string },
): TargetGuard {
  const session = selectSessionById(state, input.sessionId);
  if (!session) {
    return { ok: false, reason: "session-missing" };
  }
  if (session.stream.requestId !== input.requestId) {
    return { ok: false, reason: "stale-request" };
  }
  const target = locateToolCall(session, input.toolCallId);
  if (!target) {
    return { ok: false, reason: "tool-call-missing" };
  }
  if (target.toolCallState.status !== "generated") {
    return { ok: false, reason: "not-awaiting-approval" };
  }
  return { ok: true, target };
}

function skipped(
  toolCallId: string,
  reason: SessionToolSkipReason,
): SessionToolOutcome {
  return { status: "skipped", toolCallId, reason };
}

function rejectionContextItem(): ContextItem {
  return {
    icon: "problems",
    name: "Tool Call Rejected",
    description: "User skipped the tool call",
    content: `The user skipped the tool call.
If the tool call is optional or non-critical to the main goal, skip it and continue with the next step.
If the tool call is essential, try an alternative approach.
If no alternatives exist, offer to pause here.`,
    hidden: true,
  };
}

function failureContextItem(
  toolCallState: ToolCallState,
  message: string,
): ContextItem {
  return {
    icon: "problems",
    name: "Tool Call Error",
    description: "Tool Call Failed",
    content: `${toolCallState.toolCall.function.name} failed with the message: ${message}\n\nPlease try something else or request further instructions.`,
    hidden: false,
  };
}

// ── Execution ───────────────────────────────────────────────────────────

type ToolExecution = {
  output?: ContextItem[];
  mcpUiState?: McpUiState;
  error?: ContinueError;
  /** Whether the turn may continue once the result is recorded. */
  continueTurn: boolean;
};

async function executeToolCall(
  toolCallState: ToolCallState,
  extras: Parameters<typeof callClientTool>[1],
): Promise<ToolExecution> {
  const isClientTool = CLIENT_TOOLS_IMPLS.some(
    (toolName) => toolName === toolCallState.toolCall.function.name,
  );

  if (isClientTool) {
    // Tool errors are returned as output; anything thrown here is a stream
    // error and is handled by the caller.
    const { output, respondImmediately, error } = await callClientTool(
      toolCallState,
      extras,
    );
    return { output, error, continueTurn: respondImmediately };
  }

  const result = await extras.ideMessenger.request("tools/call", {
    toolCall: toolCallState.toolCall,
  });
  if (result.status === "error") {
    return {
      error: new ContinueError(ContinueErrorReason.Unspecified, result.error),
      continueTurn: false,
    };
  }
  return {
    output: result.content.contextItems,
    mcpUiState: result.content.mcpUiState,
    error: result.content.errorMessage
      ? new ContinueError(
          result.content.errorReason || ContinueErrorReason.Unspecified,
          result.content.errorMessage,
        )
      : undefined,
    continueTurn: true,
  };
}

/**
 * Writes the settled tool call back into the owning session. Re-reads the
 * runtime after every await: the session may have been closed, replaced by a
 * newer request or evicted while the tool was running.
 */
function writeToolResult(
  state: ThunkApiType["state"],
  input: { sessionId: string; requestId: string; toolCallId: string },
  messageId: string,
):
  | { ok: true; item: ChatHistoryItemWithMessageId }
  | { ok: false; reason: SessionToolSkipReason } {
  const session = selectSessionById(state, input.sessionId);
  if (!session) {
    return { ok: false, reason: "session-missing" };
  }
  if (session.stream.requestId !== input.requestId) {
    return { ok: false, reason: "stale-request" };
  }
  const item = session.history.find((entry) => entry.message.id === messageId);
  if (!item) {
    return { ok: false, reason: "tool-call-missing" };
  }
  return { ok: true, item };
}

// ── Approve ─────────────────────────────────────────────────────────────

type ApproveInput = {
  sessionId: string;
  requestId: string;
  toolCallId: string;
  /**
   * Set by the stream runner for `allowedWithoutPermission` calls. The
   * approval UI is skipped upstream; the state machine is identical.
   */
  isAutoApproved?: boolean;
  depth?: number;
  /**
   * Batch entry point: settle the call but let the caller decide when to
   * continue the loop, so parallel calls do not each start a model request.
   */
  deferContinuation?: boolean;
};

type ToolLoopApi = {
  dispatch: AppThunkDispatch;
  getState: () => ThunkApiType["state"];
  ideMessenger: ThunkExtrasType["ideMessenger"];
};

type ContinueInput = {
  sessionId: string;
  requestId: string;
  toolCallId: string;
  depth?: number;
};

async function runApproveToolCall(
  input: ApproveInput,
  { dispatch, getState, ideMessenger }: ToolLoopApi,
): Promise<SessionToolOutcome> {
  const { sessionId, requestId, toolCallId } = input;
  const depth =
    input.depth ?? selectSessionById(getState(), sessionId)?.stream.depth ?? 0;

  const guard = guardAwaitingToolCall(getState(), input);
  if (!guard.ok) {
    return skipped(toolCallId, guard.reason);
  }
  const { target } = guard;
  const messageId = target.assistantItem.message.id;
  const api = { dispatch, getState };

  // Re-evaluate the tool policy against the current session mode, activeTools,
  // and toolPolicies before transitioning to `calling` so mode switches (e.g.
  // Agent -> Plan) or policy exclusions made while awaiting approval are enforced.
  const currentState = getState();
  const currentSession = selectSessionById(currentState, sessionId);
  const configuredTools = currentState.config.config.tools ?? [];
  const activeTools = selectSessionActiveTools(currentState, sessionId);
  const toolName = target.toolCallState.toolCall.function.name;
  const toolGroup =
    target.toolCallState.tool?.group ??
    configuredTools.find((t) => t.function.name === toolName)?.group;
  const isGroupExcluded =
    !!toolGroup && currentState.ui.toolGroupSettings?.[toolGroup] === "exclude";
  const isFilteredOutFromConfigured =
    configuredTools.some((t) => t.function.name === toolName) &&
    !activeTools.some((t) => t.function.name === toolName);

  const evaluated =
    isGroupExcluded || isFilteredOutFromConfigured
      ? {
          policy: "disabled" as const,
          displayValue: `${toolName} is disabled by current mode or tool policy.`,
          toolCallState: target.toolCallState,
        }
      : await evaluateToolPolicy(
          ideMessenger,
          activeTools,
          target.toolCallState,
          currentState.ui.toolSettings,
          currentSession?.mode,
        );

  // Re-verify that the session/request/tool call is still awaiting approval after async policy check.
  const postPolicyGuard = guardAwaitingToolCall(getState(), input);
  if (!postPolicyGuard.ok) {
    return skipped(toolCallId, postPolicyGuard.reason);
  }

  if (evaluated.policy === "disabled") {
    const violationOutput = [
      policyViolationContextItem(target.toolCallState, evaluated.displayValue),
    ];
    applySessionToolCallUpdate(api, {
      sessionId,
      messageId,
      toolCallId,
      patch: {
        status: "errored",
        output: violationOutput,
      },
    });
    logToolUsage(
      target.toolCallState,
      false,
      false,
      ideMessenger,
      violationOutput,
    );
    void dispatch(
      enqueueSessionSave({
        sessionId,
        reason: "TOOL_CALL_APPROVED",
        measurementIntent: NO_MEASUREMENT,
      }),
    );

    let continuationRequested = false;
    if (!input.deferContinuation) {
      const loop = await runContinueToolLoop(
        { sessionId, requestId, toolCallId, depth },
        { dispatch, getState, ideMessenger },
      );
      continuationRequested = !!loop.continuationRequested;
    }

    return {
      status: "errored",
      toolCallId,
      errorMessage:
        evaluated.displayValue ||
        `Tool ${toolName} is disabled by security policy.`,
      continuationRequested,
    };
  }

  if (input.isAutoApproved && evaluated.policy === "allowedWithPermission") {
    dispatch(pauseSessionStream({ sessionId, requestId, depth }));
    return skipped(toolCallId, "not-awaiting-approval");
  }

  applySessionToolCallUpdate(api, {
    sessionId,
    messageId,
    toolCallId,
    patch: { status: "calling" },
  });

  const execution = await executeToolCall(target.toolCallState, {
    dispatch,
    getState,
    ideMessenger,
    sessionId,
  });

  const output = execution.error
    ? [failureContextItem(target.toolCallState, execution.error.message)]
    : execution.output;

  const write = writeToolResult(getState(), input, messageId);
  if (!write.ok) {
    return skipped(toolCallId, write.reason);
  }

  // Client tools that do not respond immediately (edit / find-and-replace)
  // stay `calling`: the apply-state flow closes them (方案.md §五.20). Only an
  // error or an immediately-responding tool settles the call here.
  applySessionToolCallUpdate(api, {
    sessionId,
    messageId,
    toolCallId,
    patch: {
      ...(execution.error
        ? { status: "errored" as const }
        : execution.continueTurn
          ? { status: "done" as const }
          : {}),
      output,
      mcpUiState: execution.mcpUiState,
    },
  });

  logToolUsage(
    target.toolCallState,
    !execution.error,
    !execution.error,
    ideMessenger,
    output,
  );
  void dispatch(
    enqueueSessionSave({
      sessionId,
      reason: "TOOL_CALL_APPROVED",
      // 工具中间态：terminal 才是本回合的内容版本边界。
      measurementIntent: NO_MEASUREMENT,
    }),
  );

  // A client tool that waits for its apply flow leaves the request live but
  // stops the stream, so the UI can show the pending apply state.
  if (!execution.continueTurn && !execution.error) {
    dispatch(pauseSessionStream({ sessionId, requestId, depth }));
  }

  let continuationRequested = false;
  if (execution.continueTurn && !input.deferContinuation) {
    const loop = await runContinueToolLoop(
      { sessionId, requestId, toolCallId, depth },
      { dispatch, getState, ideMessenger },
    );
    continuationRequested = !!loop.continuationRequested;
  }

  return {
    status: execution.error ? "errored" : "approved",
    toolCallId,
    errorMessage: execution.error?.message,
    continuationRequested,
  };
}

export const approveToolCall = createAsyncThunk<
  SessionToolOutcome,
  ApproveInput,
  ThunkApiType
>("sessions/approveToolCall", async (input, { dispatch, extra, getState }) =>
  runApproveToolCall(input, {
    dispatch,
    getState,
    ideMessenger: extra.ideMessenger,
  }),
);

type BatchInput = {
  sessionId: string;
  requestId: string;
  toolCallIds: string[];
  depth?: number;
  isAutoApproved?: boolean;
};

async function runBatch(
  input: BatchInput,
  api: ToolLoopApi,
  settle: (
    input: ApproveInput,
    api: ToolLoopApi,
  ) => Promise<SessionToolOutcome>,
): Promise<SessionToolOutcome[]> {
  const { sessionId, requestId, toolCallIds, isAutoApproved } = input;
  const depth =
    input.depth ??
    selectSessionById(api.getState(), sessionId)?.stream.depth ??
    0;
  const outcomes: SessionToolOutcome[] = [];
  for (const toolCallId of toolCallIds) {
    outcomes.push(
      await settle(
        {
          sessionId,
          requestId,
          toolCallId,
          depth,
          isAutoApproved,
          deferContinuation: true,
        },
        api,
      ),
    );
  }
  // Record every terminal result first, then continue the loop once if all calls are terminal.
  for (const toolCallId of toolCallIds) {
    appendToolResultMessage(
      api.getState(),
      { sessionId, requestId, toolCallId },
      api.dispatch,
    );
  }
  const anchor = toolCallIds[toolCallIds.length - 1];
  if (anchor) {
    await runContinueToolLoop(
      { sessionId, requestId, toolCallId: anchor, depth },
      api,
    );
  }
  return outcomes;
}

export const approveToolCalls = createAsyncThunk<
  SessionToolOutcome[],
  BatchInput,
  ThunkApiType
>("sessions/approveToolCalls", async (input, { dispatch, extra, getState }) =>
  runBatch(
    input,
    { dispatch, getState, ideMessenger: extra.ideMessenger },
    runApproveToolCall,
  ),
);

// ── Reject ──────────────────────────────────────────────────────────────

async function runRejectToolCall(
  input: ApproveInput,
  { dispatch, getState, ideMessenger }: ToolLoopApi,
): Promise<SessionToolOutcome> {
  const { sessionId, requestId, toolCallId } = input;
  const depth =
    input.depth ?? selectSessionById(getState(), sessionId)?.stream.depth ?? 0;

  const guard = guardAwaitingToolCall(getState(), input);
  if (!guard.ok) {
    return skipped(toolCallId, guard.reason);
  }
  const { target } = guard;
  const continueAfterToolRejection =
    getState().config.config.ui?.continueAfterToolRejection;

  applySessionToolCallUpdate(
    { dispatch, getState },
    {
      sessionId,
      messageId: target.assistantItem.message.id,
      toolCallId,
      patch: {
        status: "canceled",
        ...(continueAfterToolRejection
          ? { output: [rejectionContextItem()] }
          : {}),
      },
    },
  );

  // A rejection never executes the tool; it only closes the call.
  void dispatch(
    enqueueSessionSave({
      sessionId,
      reason: "TOOL_CALL_REJECTED",
      measurementIntent: NO_MEASUREMENT,
    }),
  );

  let continuationRequested = false;
  if (!input.deferContinuation) {
    const loop = await runContinueToolLoop(
      { sessionId, requestId, toolCallId, depth },
      { dispatch, getState, ideMessenger },
    );
    continuationRequested = !!loop.continuationRequested;
  }

  return { status: "rejected", toolCallId, continuationRequested };
}

export const rejectToolCall = createAsyncThunk<
  SessionToolOutcome,
  ApproveInput,
  ThunkApiType
>("sessions/rejectToolCall", async (input, { dispatch, extra, getState }) =>
  runRejectToolCall(input, {
    dispatch,
    getState,
    ideMessenger: extra.ideMessenger,
  }),
);

export const rejectToolCalls = createAsyncThunk<
  SessionToolOutcome[],
  BatchInput,
  ThunkApiType
>("sessions/rejectToolCalls", async (input, { dispatch, extra, getState }) =>
  runBatch(
    input,
    { dispatch, getState, ideMessenger: extra.ideMessenger },
    runRejectToolCall,
  ),
);

// ── Continue ────────────────────────────────────────────────────────────

function areAllToolCallsTerminal(
  assistantItem: ChatHistoryItemWithMessageId,
  continueAfterToolRejection: boolean | undefined,
): boolean {
  const toolCallStates = assistantItem.toolCallStates;
  // Race conditions can leave the assistant item without tool state: the
  // sequence is complete in that case.
  if (!toolCallStates) {
    return true;
  }
  return toolCallStates.every(
    (state) =>
      state.status === "done" ||
      state.status === "errored" ||
      (!!continueAfterToolRejection && state.status === "canceled"),
  );
}

/**
 * Appends the tool result message exactly once once the call has reached a
 * terminal status (`done`, `errored`, or `canceled`). Calls that are still
 * `calling` (e.g. `ask_user_question` or diff apply) do not emit an empty
 * placeholder message early.
 */
function appendToolResultMessage(
  state: ThunkApiType["state"],
  { sessionId, requestId, toolCallId }: ContinueInput,
  dispatch: AppThunkDispatch,
): void {
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return;
  }
  if (findChatHistoryItemByToolCallId(session.history, toolCallId)) {
    return;
  }
  const target = locateToolCall(session, toolCallId);
  if (
    !target ||
    (target.toolCallState.status !== "done" &&
      target.toolCallState.status !== "errored" &&
      target.toolCallState.status !== "canceled")
  ) {
    return;
  }
  const toolMessage: ChatMessage = {
    role: "tool",
    content: renderContextItems(target.toolCallState.output ?? []),
    toolCallId,
  };
  dispatch(
    applySessionStreamUpdate({
      sessionId,
      requestId,
      messages: [toolMessage],
    }),
  );
}

async function runContinueToolLoop(
  input: ContinueInput,
  { dispatch, getState }: ToolLoopApi,
): Promise<SessionToolOutcome> {
  const { sessionId, requestId, toolCallId } = input;
  const state = getState();
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return skipped(toolCallId, "session-missing");
  }
  if (session.stream.requestId !== requestId) {
    return skipped(toolCallId, "stale-request");
  }
  const depth = input.depth ?? session.stream.depth ?? 0;
  const target = locateToolCall(session, toolCallId);
  if (!target) {
    return skipped(toolCallId, "tool-call-missing");
  }

  appendToolResultMessage(
    state,
    { sessionId, requestId, toolCallId },
    dispatch,
  );

  const refreshed = selectSessionById(getState(), sessionId);
  const assistantItem = refreshed?.history.find(
    (item) => item.message.id === target.assistantItem.message.id,
  );
  if (!assistantItem) {
    return skipped(toolCallId, "tool-call-missing");
  }

  if (
    !areAllToolCallsTerminal(
      assistantItem,
      getState().config.config.ui?.continueAfterToolRejection,
    )
  ) {
    // Parallel calls: the last one to settle continues the turn.
    return { status: "waiting", toolCallId, reason: "pending-tool-calls" };
  }

  void dispatch(
    enqueueSessionSave({
      sessionId,
      reason: "TOOL_SEQUENCE_COMPLETED",
      measurementIntent: NO_MEASUREMENT,
    }),
  );

  if (!sessionStreamRunner) {
    return { status: "completed", toolCallId, continuationRequested: false };
  }
  await sessionStreamRunner({ sessionId, requestId, depth: depth + 1 });
  return { status: "completed", toolCallId, continuationRequested: true };
}

export const continueToolLoop = createAsyncThunk<
  SessionToolOutcome,
  ContinueInput,
  ThunkApiType
>("sessions/continueToolLoop", async (input, { dispatch, extra, getState }) =>
  runContinueToolLoop(input, {
    dispatch,
    getState,
    ideMessenger: extra.ideMessenger,
  }),
);

// ── Active-UI entry points ──────────────────────────────────────────────

type ActiveToolInput = { toolCallId: string; depth?: number };

function activeToolTarget(
  state: ThunkApiType["state"],
): { sessionId: string; requestId: string } | undefined {
  const sessionId = state.sessions.activeSessionId;
  const requestId = sessionId
    ? state.sessions.sessionsById[sessionId]?.stream.requestId
    : undefined;
  return sessionId && requestId ? { sessionId, requestId } : undefined;
}

/**
 * Approval buttons (方案.md §五.20): the toolbar is global active UI, so it may
 * resolve the visible session — but the action itself still carries the live
 * sessionId + requestId, and a stale request is ignored.
 */
export const approveActiveToolCall = createAsyncThunk<
  SessionToolOutcome | undefined,
  ActiveToolInput,
  ThunkApiType
>("sessions/approveActiveToolCall", async (input, { dispatch, getState }) => {
  const target = activeToolTarget(getState());
  if (!target) {
    return undefined;
  }
  return (await dispatch(
    approveToolCall({ ...target, ...input }),
  ).unwrap()) as SessionToolOutcome;
});

export const rejectActiveToolCall = createAsyncThunk<
  SessionToolOutcome | undefined,
  ActiveToolInput,
  ThunkApiType
>("sessions/rejectActiveToolCall", async (input, { dispatch, getState }) => {
  const target = activeToolTarget(getState());
  if (!target) {
    return undefined;
  }
  return (await dispatch(
    rejectToolCall({ ...target, ...input }),
  ).unwrap()) as SessionToolOutcome;
});

export const settleAskUserQuestion = createAsyncThunk<
  SessionToolOutcome,
  {
    sessionId: string;
    toolCallId: string;
    resultJson: string;
    depth?: number;
  },
  ThunkApiType
>(
  "sessions/settleAskUserQuestion",
  async (
    { sessionId, toolCallId, resultJson, depth },
    { dispatch, extra, getState },
  ) => {
    const session = getState().sessions.sessionsById[sessionId];
    const requestId = session?.stream.requestId;
    if (!session || !requestId) {
      return skipped(toolCallId, "stale-request");
    }
    const target = findSessionToolCallTarget(session.history, toolCallId);
    if (!target) {
      return skipped(toolCallId, "tool-call-missing");
    }
    const resolvedDepth = depth ?? session.stream.depth ?? 0;
    applySessionToolCallUpdate(
      { dispatch, getState },
      {
        sessionId,
        messageId: target.assistantItem.message.id,
        toolCallId,
        patch: {
          status: "done",
          output: [
            {
              name: "User Answer",
              description: "Answer to ask_user_question",
              content: resultJson,
            },
          ],
        },
      },
    );
    return await runContinueToolLoop(
      { sessionId, requestId, toolCallId, depth: resolvedDepth },
      { dispatch, getState, ideMessenger: extra.ideMessenger },
    );
  },
);
