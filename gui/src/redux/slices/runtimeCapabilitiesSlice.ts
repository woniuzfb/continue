import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import type { TelemetryHost } from "../util/legacyMessageIdObservability";

/**
 * Host capabilities declared by the IDE (方案.md §九.13 / P4a of the legacy
 * message-ID work).
 *
 * A host that does not recognise a `messageType` never responds at all — VS
 * Code has no registered handler, IntelliJ only logs — so the webview request
 * stays pending forever *and* its `window` "message" listener is never removed.
 * The webview therefore must not send a type the host cannot route, which means
 * the capability has to be declared by the **host**, not inferred from the Core
 * version: Core implementing a handler says nothing about whether the host
 * forwards the request (IntelliJ routes through an explicit allow-list).
 *
 * `getIdeInfo` is the carrier: it is an existing type that every host already
 * answers, and it is registered `onWebviewOrCore`, so asking it can never fall
 * into the silent-drop path that this slice exists to avoid.
 */

export type MessageIdMigrationCapability =
  /**
   * Not asked yet. A safe-state transition triggers the probe once; nothing is
   * sent to the host until it answers.
   */
  | "unknown"
  /** The host answered and declared `capabilities.historyMigrateIds === true`. */
  | "supported"
  /** The host answered but did not declare the capability (older host). */
  | "unsupported"
  /**
   * The probe itself failed (timeout / transport error) within the bounded
   * attempt budget. This is a fact about *asking*, not about the host: it must
   * never be reported as "this session file cannot be migrated".
   */
  | "probe-failed";

export type RuntimeCapabilitiesState = {
  historyMigrateIds: MessageIdMigrationCapability;
  /**
   * Bounded probe budget. Unlike the 2s config retry loop, a failed capability
   * probe must not retry forever — it is re-attempted only by the next safe
   * state transition, up to `MAX_CAPABILITY_PROBE_ATTEMPTS`.
   */
  probeAttempts: number;
  /**
   * Normalised host dimension (P5a), derived from the **same** `getIdeInfo`
   * response the capability probe already parses — never from a second request.
   * A probe that never got an answer leaves it at `"other"`, which is the
   * honest value: the host was not identified.
   */
  host: TelemetryHost;
};

/**
 * A probe is a local IPC round-trip against a host that is already answering
 * other messages, so a handful of attempts is plenty. The budget exists to
 * bound a host that is genuinely wedged, not to paper over a transient stall.
 */
export const MAX_CAPABILITY_PROBE_ATTEMPTS = 3;

export const initialRuntimeCapabilitiesState: RuntimeCapabilitiesState = {
  historyMigrateIds: "unknown",
  probeAttempts: 0,
  host: "other",
};

export const runtimeCapabilitiesSlice = createSlice({
  name: "runtimeCapabilities",
  initialState: initialRuntimeCapabilitiesState,
  reducers: {
    setHistoryMigrateIdsCapability: (
      state,
      action: PayloadAction<MessageIdMigrationCapability>,
    ) => {
      state.historyMigrateIds = action.payload;
    },
    registerCapabilityProbeAttempt: (state) => {
      state.probeAttempts += 1;
    },
    setTelemetryHost: (state, action: PayloadAction<TelemetryHost>) => {
      state.host = action.payload;
    },
  },
});

export const {
  setHistoryMigrateIdsCapability,
  registerCapabilityProbeAttempt,
  setTelemetryHost,
} = runtimeCapabilitiesSlice.actions;

/**
 * Structural (not `RootState`) so this slice does not have to import `store`,
 * which imports every slice.
 */
export const selectMessageIdMigrationCapability = (state: {
  runtimeCapabilities: RuntimeCapabilitiesState;
}): MessageIdMigrationCapability => state.runtimeCapabilities.historyMigrateIds;

export const selectTelemetryHost = (state: {
  runtimeCapabilities: RuntimeCapabilitiesState;
}): TelemetryHost => state.runtimeCapabilities.host;

export default runtimeCapabilitiesSlice.reducer;
