import { createSelector } from "@reduxjs/toolkit";
import type { RootState } from "../store";
import type {
  SessionRuntimeState,
  SessionTabDescriptor,
} from "../slices/sessionsSlice";

/**
 * Phase 1 session selectors (方案.md §五.9).
 *
 * Every async path must pass an explicit sessionId; `activeSessionId` only
 * decides which session is visible, never which session an operation targets.
 */

export const selectActiveSessionId = (state: RootState): string | undefined =>
  state.sessions.activeSessionId;

export const selectSessionById = (
  state: RootState,
  sessionId: string,
): SessionRuntimeState | undefined => state.sessions.sessionsById[sessionId];

export const selectActiveSession = (
  state: RootState,
): SessionRuntimeState | undefined => {
  const activeSessionId = state.sessions.activeSessionId;
  return activeSessionId
    ? state.sessions.sessionsById[activeSessionId]
    : undefined;
};

export const selectTabOrder = (state: RootState): string[] =>
  state.sessions.tabOrder;

export const selectTabDescriptors = (
  state: RootState,
): Record<string, SessionTabDescriptor> => state.sessions.tabDescriptors;

export const selectTabDescriptor = (
  state: RootState,
  sessionId: string,
): SessionTabDescriptor | undefined => state.sessions.tabDescriptors[sessionId];

export const selectSessionHistory = (state: RootState, sessionId: string) =>
  state.sessions.sessionsById[sessionId]?.history ?? [];

export const selectSessionTitle = (state: RootState, sessionId: string) =>
  state.sessions.sessionsById[sessionId]?.title ??
  state.sessions.tabDescriptors[sessionId]?.title;

export const selectIsSessionStreaming = (
  state: RootState,
  sessionId: string,
): boolean =>
  state.sessions.sessionsById[sessionId]?.stream.status === "streaming";

export const selectSessionPendingApprovalCount = (
  state: RootState,
  sessionId: string,
): number => state.sessions.sessionsById[sessionId]?.pendingApprovalCount ?? 0;

export const selectHasPendingApproval = (
  state: RootState,
  sessionId: string,
): boolean => selectSessionPendingApprovalCount(state, sessionId) > 0;

/**
 * Tab bar projection: title/badges come from the descriptor plus the runtime
 * approval count. Kept as a selector so the badge is never stored twice.
 */
export const selectTabSummaries = createSelector(
  [
    selectTabOrder,
    selectTabDescriptors,
    (state: RootState) => state.sessions.sessionsById,
  ],
  (tabOrder, descriptors, sessionsById) =>
    tabOrder.map((sessionId) => {
      const runtime = sessionsById[sessionId];
      const descriptor = descriptors[sessionId];
      return {
        sessionId,
        title: runtime?.title ?? descriptor?.title ?? sessionId,
        loadState: descriptor?.loadState ?? "unloaded",
        isStreaming: runtime?.stream.status === "streaming",
        pendingApprovalCount: runtime?.pendingApprovalCount ?? 0,
      };
    }),
);
