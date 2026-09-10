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
 *
 * `staleOrigin` is set when the registry entry for this stream names a
 * *different* session than the payload (P3.1): the payload still wins, and the
 * caller may warn. It is not an error — see `resolveApplyRoute`.
 */
export type ApplyRoutingDecision =
  | {
      kind: "route";
      sessionId: string;
      toolCallId?: string;
      staleOrigin?: ApplyOrigin;
    }
  | { kind: "drop"; reason: ApplyDropReason };

export type ApplyDropReason =
  /** No payload sessionId and nothing registered for this stream. */
  | "unknown-origin"
  /** Payload names a session that has no loaded runtime to write to. */
  | "unknown-session"
  /** Payload contradicts the tool call of a tool origin for the *same* session. */
  | "tool-call-id-mismatch";

export type ApplyRouteContext = {
  /** Whether a session has a loaded runtime that apply state could be written to. */
  sessionExists: (sessionId: string) => boolean;
};

/**
 * The single routing decision for `updateApplyState` (方案.md §五.21 P1+P2+P3).
 *
 * Two identities are in play and they do **not** have equal standing:
 *
 * - the payload's `sessionId` is the **routing identity**. It comes from the
 *   request that started this apply and was carried by the IDE to the diff
 *   handler that emitted the event;
 * - a registry entry is keyed by `streamId`, and `streamId` is *not* unique per
 *   session — edit mode uses the fixed `EDIT_MODE_STREAM_ID` for every session,
 *   so one session registering overwrites another's slot. The registry is
 *   therefore only a compatibility path for hosts that send no sessionId, plus
 *   a `toolCallId` consistency check within the same session.
 *
 * ```text
 * payload.sessionId present
 *   no runtime for it                          → drop (unknown-session)
 *   otherwise                                  → route by payload.sessionId
 *     registry naming another session          → route anyway (staleOrigin, warn)
 *     registry naming the same session, tool   → toolCallId must match, else
 *                                                 drop (tool-call-id-mismatch)
 * payload.sessionId absent   (old host)
 *   registry miss                              → drop (unknown-origin)
 *   registry hit                               → route by the registry
 * either way                                  → never fall back to the visible session
 * ```
 *
 * P3.1: a registry session that disagrees with the payload must **not** veto it.
 * With the fixed edit streamId that disagreement is an expected, legitimate
 * state (S2 edited after S1), so treating it as a protocol error deterministically
 * dropped S1's own events. Only the `toolCallId` check is a real integrity check,
 * and it is scoped to the session that both sides agree on — a tool origin from
 * *another* session must never inject its `toolCallId` into this one.
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

    // The registry is consulted only where it can still be right: an origin
    // for this very session. A tool origin for another session is stale, not
    // evidence about this event.
    const sameSessionToolOrigin =
      origin?.kind === "tool" && origin.sessionId === payloadSessionId
        ? origin
        : undefined;
    if (
      sameSessionToolOrigin &&
      applyState.toolCallId &&
      applyState.toolCallId !== sameSessionToolOrigin.toolCallId
    ) {
      return { kind: "drop", reason: "tool-call-id-mismatch" };
    }

    return {
      kind: "route",
      sessionId: payloadSessionId,
      toolCallId: sameSessionToolOrigin
        ? sameSessionToolOrigin.toolCallId
        : applyState.toolCallId,
      ...(origin && origin.sessionId !== payloadSessionId
        ? { staleOrigin: origin }
        : {}),
    };
  }

  // Old host: nothing but the registry can name the session.
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
