/**
 * Legacy message-ID observability — local event emission (P5a, 方案.md §九.13 /
 * 设计 §16–§17).
 *
 * The P5 audit (设计 §16) found that **no shared event sender exists**: the only
 * sender in the repo is the CLI-owned OpenTelemetry metrics service, and the
 * only reusable piece is the opt-out predicate `IDE.isTelemetryEnabled()`.
 * P5's near-term form is therefore "observation design + local event emission":
 * the event type, the field allow-list and the emission points are pinned down
 * here, and the transport is left as a **replaceable sink seam**. No backend, no
 * OTel SDK in the GUI bundle.
 *
 * Three properties are load-bearing and are what the tests fix:
 *
 * 1. **A closed allow-list.** An event carries only stable enums. Never a
 *    session id, a message id, a title, a path, a raw Core error, a prompt, a
 *    message content or tool arguments. Callers build the object literally —
 *    never by spreading a richer report (the P4b fallback report contains a
 *    `sessionId`, so it must not be spread into an event).
 * 2. **The sink cannot affect business.** A sink that throws synchronously or
 *    rejects asynchronously is swallowed: a diagnostic must never fail a
 *    session load, a migration or a save.
 * 3. **Fail closed.** Telemetry is sent only when the host explicitly answers
 *    `isTelemetryEnabled() === true`. Unknown / false / error / timeout all mean
 *    "do not send" — with the deliberate consequence that a host which does not
 *    implement the predicate (IntelliJ today) emits nothing.
 */

/** Stable, CLI-style event name. */
export const LEGACY_MESSAGE_ID_EVENT_NAME =
  "continue_legacy_message_id_migration" as const;
export type LegacyMessageIdEventName = typeof LEGACY_MESSAGE_ID_EVENT_NAME;

/**
 * Normalised host dimension. `getIdeInfo().ideType` is `"vscode" | "jetbrains"`;
 * JetBrains is reported as `"intellij"` so the dimension matches the host names
 * used everywhere else, and the mapping lives in exactly one place.
 */
export type TelemetryHost = "vscode" | "intellij" | "other";

export type LegacyMessageIdStage = "capability" | "migration" | "fallback";

export type LegacyMessageIdOutcome =
  // stage = "capability"
  | "supported"
  | "unsupported"
  | "probe_failed"
  // stage = "migration"
  | "written"
  | "noop"
  | "session_file_invalid"
  | "migration_failed"
  | "request_timeout"
  // stage = "fallback"
  | "runtime_ids_minted";

/** Fallback counts are bucketed so the event never carries a raw number. */
export type FallbackCountBucket = "1" | "2-10" | "11-50" | "51-200" | "201+";

export type LegacyMessageIdEvent = {
  name: LegacyMessageIdEventName;
  stage: LegacyMessageIdStage;
  outcome: LegacyMessageIdOutcome;
  host: TelemetryHost;
  /** Only present for `stage: "fallback"`. */
  countBucket?: FallbackCountBucket;
};

export type LegacyMessageIdEventSink = (
  event: LegacyMessageIdEvent,
) => void | Promise<void>;

/**
 * The permission probe is a local IPC round-trip that must not hang the webview.
 * A host that does not implement `isTelemetryEnabled` (IntelliJ) never responds
 * at all, so this MUST carry a timeout that removes the `window` listener —
 * otherwise the request would leak a listener forever (the P4a hazard).
 */
export const TELEMETRY_PERMISSION_TIMEOUT_MS = 3_000;

type IsTelemetryEnabledResponse =
  | { status: "success"; content: boolean }
  | { status: "error"; error: string };

/**
 * Structural slice of `IIdeMessenger` the gate needs, so this module does not
 * depend on the React context.
 */
export interface TelemetryPermissionMessenger {
  request(
    messageType: "isTelemetryEnabled",
    data: undefined,
    options?: { timeoutMs?: number },
  ): Promise<IsTelemetryEnabledResponse>;
}

/**
 * `unknown` before the single probe; `disabled` once it fails for any reason
 * (including a host that cannot answer), which is the fail-closed default.
 */
export type TelemetryPermission = "unknown" | "enabled" | "disabled";

/**
 * The one place `ideType` becomes a telemetry host. Kept pure and exported so
 * tests can pin the exact strings (including the `jetbrains` → `intellij`
 * rename and the unknown-value fallback).
 */
export function telemetryHostFromIdeType(
  ideType: string | undefined,
): TelemetryHost {
  if (ideType === "vscode") {
    return "vscode";
  }
  if (ideType === "jetbrains") {
    return "intellij";
  }
  return "other";
}

/**
 * Bucket boundaries, fixed by tests: 1 / 2–10 / 11–50 / 51–200 / 201+.
 */
export function bucketFallbackCount(count: number): FallbackCountBucket {
  if (count <= 1) {
    return "1";
  }
  if (count <= 10) {
    return "2-10";
  }
  if (count <= 50) {
    return "11-50";
  }
  if (count <= 200) {
    return "51-200";
  }
  return "201+";
}

function noopSink(_event: LegacyMessageIdEvent): void {}

let sink: LegacyMessageIdEventSink = noopSink;

/**
 * The permission is a global host fact; it is resolved at most once per webview
 * lifetime. `telemetryPermissionInFlight` is the single-flight slot so the
 * capability / migration / fallback emission points cannot each fire their own
 * probe on first use.
 */
let telemetryPermission: TelemetryPermission = "unknown";
let telemetryPermissionInFlight: Promise<TelemetryPermission> | undefined;

export function setLegacyMessageIdEventSink(
  next: LegacyMessageIdEventSink,
): void {
  sink = next;
}

export function resetLegacyMessageIdEventSink(): void {
  sink = noopSink;
}

/** Test-only: force the resolved permission without going through a messenger. */
export function setTelemetryPermissionForTests(
  next: TelemetryPermission,
): void {
  telemetryPermission = next;
}

/** Test-only: restore the module to its boot state between tests. */
export function resetLegacyMessageIdObservabilityForTests(): void {
  sink = noopSink;
  telemetryPermission = "unknown";
  telemetryPermissionInFlight = undefined;
}

/**
 * Deliver one already-built event to the sink.
 *
 * Swallows both a synchronous throw and an asynchronous rejection: emission is
 * a side effect observed *after* the business state has been settled, so it must
 * never be able to fail a load, a migration or a save.
 */
export function emitLegacyMessageIdEvent(event: LegacyMessageIdEvent): void {
  try {
    const result = sink(event);
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(undefined, () => {});
    }
  } catch {
    // Intentionally swallowed — a diagnostic must never affect business.
  }
}

/**
 * Resolve the opt-out predicate, at most once per webview lifetime.
 *
 * `true` ⇒ `enabled`; `false`, an error response, a timeout or a missing handler
 * all ⇒ `disabled` (fail closed). Concurrent callers share one in-flight probe.
 */
export async function resolveTelemetryPermission(
  messenger: TelemetryPermissionMessenger,
): Promise<TelemetryPermission> {
  if (telemetryPermission !== "unknown") {
    return telemetryPermission;
  }
  if (telemetryPermissionInFlight) {
    return telemetryPermissionInFlight;
  }

  const run = (async (): Promise<TelemetryPermission> => {
    let resolved: TelemetryPermission = "disabled";
    try {
      const response = await messenger.request(
        "isTelemetryEnabled",
        undefined,
        { timeoutMs: TELEMETRY_PERMISSION_TIMEOUT_MS },
      );
      resolved =
        response.status === "success" && response.content === true
          ? "enabled"
          : "disabled";
    } catch {
      // Unknown messageType / timeout / transport error: privacy default is off.
      resolved = "disabled";
    }
    telemetryPermission = resolved;
    return resolved;
  })();

  telemetryPermissionInFlight = run;
  try {
    return await run;
  } finally {
    if (telemetryPermissionInFlight === run) {
      telemetryPermissionInFlight = undefined;
    }
  }
}

/**
 * Emit an event only when the host has explicitly opted in.
 *
 * If the permission is still unknown this awaits the shared probe rather than
 * dropping the event, so the first settle after boot is not lost — but it does
 * **not** queue events across the webview lifetime.
 */
export async function emitLegacyMessageIdEventIfEnabled(
  event: LegacyMessageIdEvent,
  messenger: TelemetryPermissionMessenger,
): Promise<void> {
  const permission = await resolveTelemetryPermission(messenger);
  if (permission !== "enabled") {
    return;
  }
  emitLegacyMessageIdEvent(event);
}

/**
 * The fallback emission point, wrapped so every call site builds the same
 * closed allow-list object (and never spreads the P4b report, which carries a
 * `sessionId`).
 */
export function emitLegacyFallbackMintedEvent(params: {
  mintedCount: number;
  host: TelemetryHost;
  messenger: TelemetryPermissionMessenger;
}): void {
  void emitLegacyMessageIdEventIfEnabled(
    {
      name: LEGACY_MESSAGE_ID_EVENT_NAME,
      stage: "fallback",
      outcome: "runtime_ids_minted",
      host: params.host,
      countBucket: bucketFallbackCount(params.mintedCount),
    },
    params.messenger,
  );
}
