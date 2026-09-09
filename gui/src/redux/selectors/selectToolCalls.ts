import { createSelector } from "@reduxjs/toolkit";
import { ToolStatus } from "core";
import type { RootState } from "../store";
import {
  findAllCurToolCalls,
  findAllCurToolCallsByStatus,
  findToolCallById,
  hasCurrentToolCalls,
} from "../util";

/**
 * Phase 4 (方案.md §九): tool-call and apply-state selectors read the active
 * runtime in `sessionsById[activeSessionId]` only.
 *
 * Every selector stays memoized: React's `useSelector` requires a stable
 * reference when the derived value is an array.
 */

const EMPTY_HISTORY: never[] = [];
const EMPTY_APPLY_STATES: never[] = [];

const selectActiveRuntime = (state: RootState) => {
  const sessionId = state.sessions.activeSessionId;
  return sessionId ? state.sessions.sessionsById[sessionId] : undefined;
};

const selectCompatHistory = (state: RootState) =>
  selectActiveRuntime(state)?.history ?? EMPTY_HISTORY;

const selectCompatApplyStates = (state: RootState) =>
  selectActiveRuntime(state)?.codeBlockApplyStates.states ?? EMPTY_APPLY_STATES;

// Primary selectors for tool calls
export const selectCurrentToolCalls = createSelector(
  [selectCompatHistory],
  (history) => findAllCurToolCalls(history),
);

export const selectHasCurrentToolCalls = createSelector(
  [selectCompatHistory],
  (history) => hasCurrentToolCalls(history),
);

export const selectToolCallsByStatus = createSelector(
  [selectCompatHistory, (_state: RootState, status: ToolStatus) => status],
  (history, status) => findAllCurToolCallsByStatus(history, status),
);

export const selectFirstPendingToolCall = createSelector(
  [selectCompatHistory],
  (history) =>
    findAllCurToolCallsByStatus(history, "generated")[0] || undefined,
);

// ID-based selectors for specific tool calls
export const selectToolCallById = createSelector(
  [selectCompatHistory, (_state: RootState, toolCallId: string) => toolCallId],
  (history, toolCallId) => findToolCallById(history, toolCallId),
);

export const selectApplyStateByToolCallId = createSelector(
  [
    selectCompatApplyStates,
    (_state: RootState, toolCallId: string) => toolCallId,
  ],
  (applyStates, toolCallId) =>
    applyStates.findLast((applyState) => applyState.toolCallId === toolCallId),
);

export const selectApplyStateByStreamId = createSelector(
  [selectCompatApplyStates, (_state: RootState, streamId: string) => streamId],
  (applyStates, streamId) =>
    applyStates.findLast((applyState) => applyState.streamId === streamId),
);

// Status-specific convenience selectors
export const selectPendingToolCalls = createSelector(
  [selectCompatHistory],
  (history) => findAllCurToolCallsByStatus(history, "generated"),
);

export const selectDoneApplyStates = createSelector(
  [selectCompatApplyStates],
  (states) => states.filter((applyState) => applyState.status === "done"),
);
