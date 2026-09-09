import React, { createContext, useContext } from "react";
import { useAppSelector } from "../../../redux/hooks";
import { selectSessionById } from "../../../redux/selectors/sessions";
import type { SessionRuntimeState } from "../../../redux/slices/sessionsSlice";

/**
 * 方案.md §九.0: the session a component tree belongs to is explicit context,
 * not a faked Redux store.
 *
 * - One real store, one real `activeSessionId` (the visible tab only).
 * - `sessionId` flows through this context (or props) and is auditable.
 * - Every selector inside the tree reads `sessionsById[sessionId]`.
 * - Every action/thunk inside the tree carries `sessionId` in its payload.
 */

const SessionIdContext = createContext<string | null>(null);

export function SessionScope({
  sessionId,
  children,
}: {
  sessionId: string;
  children: React.ReactNode;
}) {
  return (
    <SessionIdContext.Provider value={sessionId}>
      {children}
    </SessionIdContext.Provider>
  );
}

/** The owning session of the current tree. Throws outside a SessionScope. */
export function useSessionId(): string {
  const sessionId = useContext(SessionIdContext);
  if (!sessionId) {
    throw new Error("useSessionId must be used inside <SessionScope>");
  }
  return sessionId;
}

/** The owning session, or undefined outside a SessionScope (shell code). */
export function useOptionalSessionId(): string | undefined {
  return useContext(SessionIdContext) ?? undefined;
}

export function useSessionRuntime(): SessionRuntimeState | undefined {
  const sessionId = useSessionId();
  return useAppSelector((state) => selectSessionById(state, sessionId));
}

/**
 * True only for the tree that the real store considers visible. Use this for
 * genuinely global concerns (focus, fill-viewport, keyboard target) — never to
 * decide which session an action belongs to.
 */
export function useIsVisibleSession(): boolean {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => state.sessions.activeSessionId === sessionId,
  );
}
