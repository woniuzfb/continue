import { createAsyncThunk } from "@reduxjs/toolkit";
import { isIdeRequestTimeoutError } from "../../context/ideRequestTimeout";
import { selectSessionById } from "../selectors/sessions";
import {
  MAX_CAPABILITY_PROBE_ATTEMPTS,
  registerCapabilityProbeAttempt,
  setHistoryMigrateIdsCapability,
  setTelemetryHost,
  type MessageIdMigrationCapability,
} from "../slices/runtimeCapabilitiesSlice";
import { setMessageIdMigrationState } from "../slices/sessionsSlice";
import {
  emitLegacyMessageIdEventIfEnabled,
  LEGACY_MESSAGE_ID_EVENT_NAME,
  telemetryHostFromIdeType,
  type TelemetryHost,
} from "../util/legacyMessageIdObservability";
import type {
  AppThunkDispatch,
  RootState,
  ThunkApiType,
  ThunkExtrasType,
} from "../store";
import { hasPendingSessionSave } from "../util/sessionSaveQueue";

/**
 * Legacy message ID migration — GUI side (P4a, 方案.md §九.13).
 *
 * Core (P1–P3) stabilizes ids per process and can write them into the session
 * file, but nothing calls it: `load()` / `loadPage()` stay read-only, so
 * without an explicit `history/migrateIds` a legacy session's ids only ever
 * live in this process and change on every reload. This module is the caller.
 *
 * Three facts shape the whole design, all verified in the source:
 *
 * 1. **An unknown `messageType` produces no response at all.** VS Code's
 *    `webviewProtocol` loops over `listeners.get(type) ?? []` and only responds
 *    inside the loop; IntelliJ prints "Unknown message type" and returns. So
 *    hitting an old host does NOT produce an error envelope — it hangs. And
 *    because `IdeMessenger.request` cleans up through the response handler
 *    only, a hang leaks one `window` "message" listener per attempt (see
 *    `context/ideRequestTimeout.ts`). Consequence: `unsupported` must be decided
 *    by a **host-declared capability**, never by an error or by timing out.
 *
 * 2. **Core declaring the handler is not enough.** The path is
 *    GUI → host → pass-through → Core, and IntelliJ routes through an explicit
 *    allow-list (`MessageTypes.PASS_THROUGH_TO_CORE`). A capability must
 *    therefore come from the host, which is why it rides on `getIdeInfo` — an
 *    existing type every host already answers, registered `onWebviewOrCore`.
 *
 * 3. **A migration is not a conversation change.** It rewrites `message.id` in
 *    the disk file only. So nothing here may mark the session dirty, advance
 *    `conversationRevision`, move `persistence.revision` or touch
 *    `fullConversationMetrics` / `fullConversationMetricsMeta` — the circle keeps
 *    showing
 *    the same valid snapshot and never recompiles.
 */

/**
 * A migration is a local file rewrite behind an in-process lock. The timeout is
 * a fault barrier (extension reloading, wedged Core, broken transport), NOT a
 * capability probe: it reports `failed/REQUEST_TIMEOUT`, never `unsupported`.
 */
export const MESSAGE_ID_MIGRATION_TIMEOUT_MS = 5_000;

/**
 * `getIdeInfo` also gets a timeout so a transport stall cannot hang boot, but a
 * failure here is a fact about *asking* — it is never attributed to a session
 * file and never becomes a "migration failed" message.
 */
export const IDE_INFO_TIMEOUT_MS = 5_000;

/**
 * The one gate for `history/migrateIds`. Exported as a named predicate on
 * purpose: a chain of inline conditions is where a missing check hides.
 *
 * `persistence` is an **optional** field and `sessionActivation` never sets it,
 * so a runtime freshly loaded from disk has `persistence === undefined`. That is
 * "no persistence record to contradict us", which is why the check is written
 * as `undefined || clean` rather than `?? "clean"` — the latter silently
 * disguises a missing fact as a real `clean` object.
 *
 * `history.length > 0` covers the mirror-image trap: a brand-new session that
 * has never been saved has no file on disk, so migrating it would answer
 * `SESSION_FILE_INVALID` and show the user a failure that is not one. It does
 * not prove a file exists by itself — `!dirty`, no queued/running save and
 * clean persistence do that together.
 */
export function canMigrateSessionMessageIds(
  state: RootState,
  sessionId: string,
): boolean {
  const session = selectSessionById(state, sessionId);
  if (!session) {
    return false;
  }
  if (state.runtimeCapabilities.historyMigrateIds !== "supported") {
    return false;
  }
  // Doubles as the idempotence guard for the whole feature: whatever the
  // outcome, a session is only ever attempted once.
  if (session.messageIdMigration.state !== "not-requested") {
    return false;
  }
  if (session.history.length === 0) {
    return false;
  }
  if (session.dirty) {
    return false;
  }
  const { stream, pagination } = session;
  // `idle` alone is not enough: awaiting-approval and waiting-for-apply also
  // sit at `idle`, but keep a live `requestId` (方案.md §五.3).
  if (stream.status !== "idle" || stream.requestId !== undefined) {
    return false;
  }
  if (pagination.loading || pagination.persistPending) {
    return false;
  }
  const persistenceState = session.persistence?.state;
  if (persistenceState !== undefined && persistenceState !== "clean") {
    return false;
  }
  // The queue is module-level and can be ahead of the Redux projection, so
  // `persistence.state` is not sufficient evidence that no write is in flight.
  if (hasPendingSessionSave(sessionId)) {
    return false;
  }
  return true;
}

/**
 * Single-flight slot for the capability probe.
 *
 * The capability is a **global host fact**, so it must not be probed once per
 * trigger. Without this slot every trigger that arrives before the first
 * `getIdeInfo` resolves starts its own request:
 *
 *   A: unknown/0 → attempts=1 → await getIdeInfo
 *   B: unknown/1 → attempts=2 → await getIdeInfo
 *   C: unknown/2 → attempts=3 → await getIdeInfo
 *
 * which spends the whole retry budget on start-up concurrency (the boot probe
 * and the first session load are dispatched from two different effects in the
 * same commit) and opens several listeners that only a timeout will clean up.
 * Callers that arrive mid-flight await this promise and reuse its result
 * instead of sending anything, so a concurrent trigger still migrates.
 */
let capabilityProbeInFlight: Promise<void> | undefined;

/**
 * Monotonic and **never reset**. Every probe captures the value it started
 * with and drops its own result if a newer probe has begun meanwhile:
 * otherwise a late failure from an older flight could overwrite a newer
 * `supported` with `probe-failed`, silently disabling migration for a host
 * that does support it. The counter deliberately survives
 * `resetCapabilityProbeForTests` so a result from a cleared flight cannot be
 * mistaken for the token of the flight that replaced it.
 */
let capabilityProbeGeneration = 0;

/**
 * Test-only: drop the in-flight slot so a store's boot state is not shared
 * with the next test. The generation counter is intentionally left alone.
 */
export function resetCapabilityProbeForTests(): void {
  capabilityProbeInFlight = undefined;
}

/** The slice of the thunk API the probe needs, so it can live outside the thunk. */
type CapabilityProbeApi = {
  dispatch: AppThunkDispatch;
  getState: () => RootState;
  extra: ThunkExtrasType;
};

async function runCapabilityProbe(api: CapabilityProbeApi): Promise<void> {
  const generation = ++capabilityProbeGeneration;
  // Counted here, once per real request — not per caller.
  api.dispatch(registerCapabilityProbeAttempt());

  let next: MessageIdMigrationCapability;
  // The same `getIdeInfo` response that decides the capability also identifies
  // the host — P5 reuses it rather than sending a second request. A probe that
  // never got an answer leaves the host unidentified ("other").
  let host: TelemetryHost = "other";
  try {
    const result = await api.extra.ideMessenger.request(
      "getIdeInfo",
      undefined,
      {
        timeoutMs: IDE_INFO_TIMEOUT_MS,
      },
    );
    if (result.status === "success") {
      host = telemetryHostFromIdeType(result.content?.ideType);
      next =
        result.content?.capabilities?.historyMigrateIds === true
          ? "supported"
          : "unsupported";
    } else {
      next = "probe-failed";
    }
  } catch {
    // A failed probe is a fact about *asking*, not about the host: it never
    // becomes `unsupported`, so a stalled transport cannot permanently disable
    // migration.
    next = "probe-failed";
  }

  // Superseded: a newer flight has started, so its answer is authoritative.
  if (generation !== capabilityProbeGeneration) {
    return;
  }
  api.dispatch(setHistoryMigrateIdsCapability(next));
  api.dispatch(setTelemetryHost(host));

  // P5a: the capability settles exactly once — `supported`/`unsupported` never
  // retry. A probe failure is only reported once the bounded budget is spent,
  // not on every transient miss (three retries are one decision procedure).
  if (next === "supported" || next === "unsupported") {
    void emitLegacyMessageIdEventIfEnabled(
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "capability",
        outcome: next,
        host,
      },
      api.extra.ideMessenger,
    );
  } else if (
    api.getState().runtimeCapabilities.probeAttempts >=
    MAX_CAPABILITY_PROBE_ATTEMPTS
  ) {
    void emitLegacyMessageIdEventIfEnabled(
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "capability",
        outcome: "probe_failed",
        host,
      },
      api.extra.ideMessenger,
    );
  }
}

/**
 * Ask the host whether it forwards `history/migrateIds`.
 *
 * Settled is never re-asked; a failed probe retries only up to
 * `MAX_CAPABILITY_PROBE_ATTEMPTS` and only when another safe-state transition
 * calls it — deliberately not the 2s-forever loop the config round-trip uses.
 * Concurrent callers share one request (see `capabilityProbeInFlight`).
 */
export const probeHostCapabilities = createAsyncThunk<void, void, ThunkApiType>(
  "runtimeCapabilities/probe",
  async (_, { dispatch, getState, extra }) => {
    const { historyMigrateIds, probeAttempts } = getState().runtimeCapabilities;
    if (
      historyMigrateIds === "supported" ||
      historyMigrateIds === "unsupported"
    ) {
      return;
    }
    if (probeAttempts >= MAX_CAPABILITY_PROBE_ATTEMPTS) {
      return;
    }
    if (capabilityProbeInFlight) {
      // Someone already asked. Reuse the answer and spend no attempt: the
      // caller goes on to read the capability after this resolves.
      await capabilityProbeInFlight;
      return;
    }

    const run = runCapabilityProbe({ dispatch, getState, extra });
    capabilityProbeInFlight = run;
    try {
      await run;
    } finally {
      // Identity-checked: after a test reset a *newer* flight may own the slot.
      if (capabilityProbeInFlight === run) {
        capabilityProbeInFlight = undefined;
      }
    }
  },
);

/**
 * Run the migration for one session at most once.
 *
 * The gate runs here rather than only at the trigger sites so that every entry
 * point shares one definition of "safe", and so a state change between the
 * trigger and this call still cannot produce an unsafe request.
 */
export const maybeMigrateSessionMessageIds = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/migrateMessageIds",
  async ({ sessionId }, { dispatch, getState, extra }) => {
    if (!canMigrateSessionMessageIds(getState(), sessionId)) {
      return;
    }
    // `pending` is also the concurrency guard: the gate above refuses anything
    // that is no longer `not-requested`, so a second trigger cannot double-send.
    dispatch(
      setMessageIdMigrationState({
        sessionId,
        migration: { state: "pending" },
      }),
    );

    let response;
    try {
      response = await extra.ideMessenger.request(
        "history/migrateIds",
        { id: sessionId },
        { timeoutMs: MESSAGE_ID_MIGRATION_TIMEOUT_MS },
      );
    } catch (error) {
      // A timeout means the host declared the capability but did not answer:
      // `failed`, never `unsupported`. `request()` has already removed the
      // listener, so a late response is dropped instead of settling twice.
      dispatch(
        setMessageIdMigrationState({
          sessionId,
          migration: {
            state: "failed",
            code: isIdeRequestTimeoutError(error)
              ? "REQUEST_TIMEOUT"
              : "MESSAGE_ID_MIGRATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      // P5a: the event carries only the stable outcome enum, never the raw
      // error text (which can carry a path) or the session id.
      void emitLegacyMessageIdEventIfEnabled(
        {
          name: LEGACY_MESSAGE_ID_EVENT_NAME,
          stage: "migration",
          outcome: isIdeRequestTimeoutError(error)
            ? "request_timeout"
            : "migration_failed",
          host: getState().runtimeCapabilities.host,
        },
        extra.ideMessenger,
      );
      return;
    }

    if (response.status === "error") {
      // Only the two documented codes exist (设计 §8). "Already migrated" and
      // "nothing to migrate" are success no-ops, not errors. This must stay
      // visible: `ensureMessageIds` mints GUI ids as a stopgap, and silently
      // minting over a failed migration is exactly the bug P4 removes.
      dispatch(
        setMessageIdMigrationState({
          sessionId,
          migration: {
            state: "failed",
            code:
              response.errorCode === "SESSION_FILE_INVALID"
                ? "SESSION_FILE_INVALID"
                : "MESSAGE_ID_MIGRATION_FAILED",
            message: response.error,
          },
        }),
      );
      void emitLegacyMessageIdEventIfEnabled(
        {
          name: LEGACY_MESSAGE_ID_EVENT_NAME,
          stage: "migration",
          outcome:
            response.errorCode === "SESSION_FILE_INVALID"
              ? "session_file_invalid"
              : "migration_failed",
          host: getState().runtimeCapabilities.host,
        },
        extra.ideMessenger,
      );
      return;
    }

    dispatch(
      setMessageIdMigrationState({
        sessionId,
        migration: {
          state: "succeeded",
          migrated: response.content.migrated,
          addedCount: response.content.addedCount,
        },
      }),
    );
    // `migrated: false` is a success no-op, not an error — the event keeps the
    // two apart so a host that never needed migration is not read as a failure.
    void emitLegacyMessageIdEventIfEnabled(
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "migration",
        outcome: response.content.migrated ? "written" : "noop",
        host: getState().runtimeCapabilities.host,
      },
      extra.ideMessenger,
    );
  },
);

/**
 * The single entry point every trigger uses (runtime loaded, save settled,
 * stream terminal, paging finished). Triggers must never re-implement any part
 * of the decision — they just say "this session may now be safe".
 */
export const scheduleMessageIdMigrationIfSafe = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/scheduleMessageIdMigration",
  async ({ sessionId }, { dispatch, getState }) => {
    if (!selectSessionById(getState(), sessionId)) {
      return;
    }

    const capability = getState().runtimeCapabilities.historyMigrateIds;
    if (capability !== "supported" && capability !== "unsupported") {
      await dispatch(probeHostCapabilities());
    }
    const resolved = getState().runtimeCapabilities.historyMigrateIds;

    if (resolved === "unsupported") {
      // The host never declared the capability, so nothing is sent. Recording
      // it per session keeps the UI state complete instead of leaving sessions
      // stuck at `not-requested` forever.
      const session = selectSessionById(getState(), sessionId);
      if (session?.messageIdMigration.state === "not-requested") {
        dispatch(
          setMessageIdMigrationState({
            sessionId,
            migration: { state: "unsupported" },
          }),
        );
      }
      return;
    }
    // `unknown` (budget spent) / `probe-failed`: stay at `not-requested` and
    // wait for another trigger, so a transient stall is never reported as a
    // session-level failure.
    if (resolved !== "supported") {
      return;
    }
    await dispatch(maybeMigrateSessionMessageIds({ sessionId }));
  },
);
