import { createSelector } from "@reduxjs/toolkit";
import type { ModelDescription } from "core";
import {
  resolveSessionChatModel,
  resolveSessionChatModelByRef,
  sessionChatModelRefOf as sessionChatModelRefOfShared,
  type SessionChatModelResolution,
} from "core/util/sessionChatModel";
import type { RootState } from "../store";
import type {
  SessionRuntimeState,
  SessionTabDescriptor,
  SessionChatModelRef,
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

/**
 * Model used by a session's own request (方案.md §五.17/§五.20, §7.5.4).
 *
 * `selectSelectedChatModel` returns the *active tab's* projection, which must
 * never leak into a background session's stream. This selector resolves the
 * session's own choice and falls back to the persisted user choice — never to
 * `activeSessionModelProjection`.
 *
 * The rule itself lives in Core (`resolveSessionChatModel`) so the GUI and Core cannot drift into
 * two resolutions of the same session: what the toolbar shows, what a turn snapshots and what Core
 * ends up calling must all be one decision, taken in one place.
 */
export const selectSessionChatModelResolution = (
  state: RootState,
  sessionId: string,
): SessionChatModelResolution<ModelDescription> => {
  const session = state.sessions.sessionsById[sessionId];
  const models = state.config.config?.modelsByRole?.chat ?? [];
  return resolveSessionChatModel(models, {
    ref: session?.chatModelRef,
    title: session?.chatModelTitle,
    defaultModel: state.config.config.selectedModelByRole.chat ?? undefined,
  });
};

/** The resolved model, or `undefined` when the session's choice cannot be proven unique. */
export const selectSessionChatModel = (
  state: RootState,
  sessionId: string,
): ModelDescription | undefined => {
  const resolution = selectSessionChatModelResolution(state, sessionId);
  return resolution.status === "resolved" ? resolution.model : undefined;
};

/** 方案.md §7.5.4: unique exact match on the stable identity, or nothing. */
export const selectChatModelByRef = (
  state: RootState,
  ref: SessionChatModelRef,
): ModelDescription | undefined => {
  const models = state.config.config?.modelsByRole?.chat ?? [];
  const resolution = resolveSessionChatModelByRef(models, ref);
  return resolution.status === "resolved" ? resolution.model : undefined;
};

export const sessionChatModelRefOf = (
  model: ModelDescription | undefined,
): SessionChatModelRef | undefined => sessionChatModelRefOfShared(model);

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
        // Background failure is visible in the tab bar (方案.md §七.7).
        persistenceState: runtime?.persistence?.state ?? "clean",
        interrupted: runtime?.interrupted ?? false,
      };
    }),
);
