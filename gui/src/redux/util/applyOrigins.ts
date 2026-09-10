import type { ApplyState } from "core";

/**
 * Where an apply event came from (方案.md §五.21).
 *
 * A discriminated union rather than `toolCallId?: string`: an optional field
 * would allow a *tool* origin to be built without its toolCallId, and a tool
 * apply that silently lost its id would then be routed as if it were an edit.
 *
 * The three kinds are the three GUI entry points that can start a diff stream:
 *
 * - `tool` — a chat tool call applied through `applySessionForEditTool`;
 * - `edit` — inline edit mode (⌘I), which has no tool call at all;
 * - `code-block` — the Apply button on a chat code block, which also has no
 *   tool call (the IDE is told a `streamId` and echoes it back).
 */
export type ApplyOrigin =
  | { kind: "tool"; sessionId: string; toolCallId: string }
  | { kind: "edit"; sessionId: string }
  | { kind: "code-block"; sessionId: string };

/**
 * `streamId → origin`, recorded when the apply request is issued.
 *
 * In-memory only: a webview reload empties it, which is why an unregistered
 * event must be dropped rather than guessed at (see `resolveApplyRoute`).
 *
 * Lives in `util/` rather than in `thunks/sessionApplyState.ts` so that
 * `thunks/edit.ts` can register its edit origin without an
 * `edit ↔ sessionApplyState` import cycle (`sessionApplyState` already imports
 * `exitEdit` from `edit`).
 */
const applyOrigins = new Map<string, ApplyOrigin>();

/** A chat tool call's apply: both identities are known when it is issued. */
export function registerToolApplyOrigin(
  streamId: string,
  origin: { sessionId: string; toolCallId: string },
): void {
  applyOrigins.set(streamId, { kind: "tool", ...origin });
}

/**
 * Edit mode (⌘I) has no tool call, so its origin only carries the session.
 * Registering it is what stops edit applies from having to guess a session —
 * they used to fall back to whatever session happened to be visible.
 */
export function registerEditApplyOrigin(
  streamId: string,
  origin: { sessionId: string },
): void {
  applyOrigins.set(streamId, { kind: "edit", ...origin });
}

/**
 * The Apply button on a chat code block. The streamId is generated per code
 * block by the renderer and passed to the IDE, which echoes it on every
 * `updateApplyState` — so without this record those events have no owner and
 * must be dropped, leaving the toolbar stuck on "applying…".
 */
export function registerCodeBlockApplyOrigin(
  streamId: string,
  origin: { sessionId: string },
): void {
  applyOrigins.set(streamId, { kind: "code-block", ...origin });
}

export function lookupApplyOrigin(streamId: string): ApplyOrigin | undefined {
  return applyOrigins.get(streamId);
}

/** Test helper: drop recorded apply origins (also models a webview reload). */
export function resetApplyOrigins(): void {
  applyOrigins.clear();
}

/** Where an incoming `updateApplyState` event must be written. */
export type ApplyRoutingDecision =
  | { kind: "route"; sessionId: string; toolCallId?: string }
  | { kind: "drop"; reason: "unknown-origin" | "tool-call-id-mismatch" };

/**
 * The single routing decision for `updateApplyState` (方案.md §五.21).
 *
 * The event payload carries no sessionId, so the origin registry is the only
 * authority for which session an apply belongs to. An unregistered stream is
 * **dropped** — never routed to the active session: `activeSessionId` is not
 * this event's identity, and guessing it wrote apply state into the wrong
 * session (and could advance that session's `codeBlockApplyStates.curIndex`).
 *
 * The payload's `toolCallId` may only *confirm* a tool origin, never override
 * it — accepting it would let a payload rewrite the registered identity. A
 * non-tool origin has no registered toolCallId to compare against, so the
 * payload's value is passed through unchanged (legacy parity: a code block
 * inside a tool call still reports the tool call it belongs to).
 */
export function resolveApplyRoute(
  applyState: ApplyState,
): ApplyRoutingDecision {
  const origin = lookupApplyOrigin(applyState.streamId);
  if (!origin) {
    return { kind: "drop", reason: "unknown-origin" };
  }
  if (origin.kind === "tool") {
    if (applyState.toolCallId && applyState.toolCallId !== origin.toolCallId) {
      return { kind: "drop", reason: "tool-call-id-mismatch" };
    }
    return {
      kind: "route",
      sessionId: origin.sessionId,
      toolCallId: origin.toolCallId,
    };
  }
  return {
    kind: "route",
    sessionId: origin.sessionId,
    toolCallId: applyState.toolCallId,
  };
}
