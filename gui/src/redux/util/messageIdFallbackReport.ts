import type { MessageIdMigrationCapability } from "../slices/runtimeCapabilitiesSlice";

/**
 * Diagnostic sink for the GUI's message-id fallback (P4b-2, 方案.md §九.13).
 *
 * Every load path may have to mint a runtime id when the disk response carries
 * none. That is the *normal* path for an old host, so it must not become an
 * error, a banner or extra Redux state — but it must be observable, otherwise a
 * regression where Core stops returning ids would be silent forever.
 *
 * Hence a plain module-level reporter instead of store state:
 *   · it never touches the session runtime, so it cannot mark a session dirty,
 *     advance `historyRevision`, move `persistence.revision` or invalidate
 *     `contextMetrics`;
 *   · tests swap it for a capture function and assert on the reports;
 *   · nothing here is a telemetry endpoint (P5 decides the event schema).
 */

export type MessageIdFallbackReport = {
  sessionId: string;
  /** Items that had no persisted `message.id` and were given a runtime one. */
  mintedCount: number;
  /**
   * The host capability at that moment. `unsupported` is the ordinary legacy
   * path. `supported` is worth recording, but it only means the host forwards
   * `history/migrateIds` — it is **not** equivalent to a promise that load
   * returns ids, so a supported host with an id-less response is a fact to
   * investigate, never a protocol violation and never a reason to fail a load.
   */
  hostCapability: MessageIdMigrationCapability;
};

export type MessageIdFallbackReporter = (
  report: MessageIdFallbackReport,
) => void;

const LOG_PREFIX = "[message-id-fallback]";

function defaultReporter(report: MessageIdFallbackReport): void {
  console.info(
    `${LOG_PREFIX} session=${report.sessionId} minted=${report.mintedCount} ` +
      `hostCapability=${report.hostCapability}`,
  );
}

let reporter: MessageIdFallbackReporter = defaultReporter;

export function setMessageIdFallbackReporter(
  next: MessageIdFallbackReporter,
): void {
  reporter = next;
}

export function resetMessageIdFallbackReporter(): void {
  reporter = defaultReporter;
}

/**
 * Record that a load path had to mint runtime ids.
 *
 * Reporting is diagnostic, so a failing reporter must never break a session
 * load — hence the guard rather than letting the error propagate into the
 * activation pipeline.
 */
export function reportMessageIdFallback(report: MessageIdFallbackReport): void {
  try {
    reporter(report);
  } catch (error) {
    console.warn(`${LOG_PREFIX} reporter threw`, error);
  }
}
