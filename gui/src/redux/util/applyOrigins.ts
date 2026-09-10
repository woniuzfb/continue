import type { UpdateApplyStatePayload } from "core";

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

/**
 * Where an incoming `updateApplyState` event must be written.
 *
 * `sessionId` is the routed identity; `toolCallId` (when the apply is a tool
 * call) is only a locator inside that session.
 */
export type ApplyRoutingDecision =
  | { kind: "route"; sessionId: string; toolCallId?: string }
  | { kind: "drop"; reason: ApplyDropReason };

export type ApplyDropReason =
  /** No payload sessionId and nothing registered for this stream. */
  | "unknown-origin"
  /** Payload and registry name different sessions: one identity is already wrong. */
  | "session-id-mismatch"
  /** Payload names a session that has no loaded runtime to write to. */
  | "unknown-session"
  /** Payload contradicts the registered tool call of a registered tool origin. */
  | "tool-call-id-mismatch";

export type ApplyRouteContext = {
  /** Whether a session has a loaded runtime that apply state could be written to. */
  sessionExists: (sessionId: string) => boolean;
};

/**
 * The single routing decision for `updateApplyState` (方案.md §五.21 P1+P2+P3).
 *
 * The apply-origin registry is written when the apply request is issued, and
 * the event's payload may additionally name its session (P3). The decision is:
 *
 * ```text
 * payload.sessionId present            → it is the authority
 *   no runtime for it                  → drop (unknown-session)
 *   registry names a different session → drop (session-id-mismatch)
 * payload.sessionId absent             → old host: use the registry
 *   registry miss                      → drop (unknown-origin)
 * either way                           → never fall back to the visible session
 * ```
 *
 * A payload/registry conflict is **dropped rather than resolved**: it proves
 * one of the two links in the protocol is wrong, and silently preferring either
 * side is how a cross-session write happens. Neither side may fall back to
 * `activeSessionId`, which is not this event's identity.
 *
 * The payload's `toolCallId` may only *confirm* a tool origin, never override
 * it. A non-tool origin has no registered toolCallId to check against, so a
 * payload value is passed through (legacy parity: a code block inside a tool
 * call still reports the tool call it belongs to).
 */
export function resolveApplyRoute(
  applyState: UpdateApplyStatePayload,
  { sessionExists }: ApplyRouteContext,
): ApplyRoutingDecision {
  const origin = lookupApplyOrigin(applyState.streamId);
  const payloadSessionId = applyState.sessionId;

  if (payloadSessionId) {
    if (!sessionExists(payloadSessionId)) {
      return { kind: "drop", reason: "unknown-session" };
    }
    if (origin && origin.sessionId !== payloadSessionId) {
      return { kind: "drop", reason: "session-id-mismatch" };
    }
  } else if (!origin) {
    return { kind: "drop", reason: "unknown-origin" };
  }

  // One of the two is present: the payload wins when it exists, the registry
  // covers hosts that do not send it yet.
  const sessionId = payloadSessionId ?? origin!.sessionId;

  if (origin?.kind === "tool") {
    if (applyState.toolCallId && applyState.toolCallId !== origin.toolCallId) {
      return { kind: "drop", reason: "tool-call-id-mismatch" };
    }
    return {
      kind: "route",
      sessionId,
      toolCallId: origin.toolCallId,
    };
  }
  return {
    kind: "route",
    sessionId,
    toolCallId: applyState.toolCallId,
  };
}
