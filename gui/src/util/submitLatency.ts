/**
 * Submit / terminal latency instrumentation (workflow: "submit latency and retry
 * boundary").
 *
 * Why this exists: after the submitted-turn commit became atomic (Stage 2F), the user
 * bubble only reaches the viewport **after** the editor content has been resolved — and
 * that resolution awaits context IPC (a `currentFile` request is issued on every send
 * unless `noContext` is set). The reported symptom is a ~1s wait with no bubble. Which
 * phase actually owns that time (current file? a default provider? codebase? the atomic
 * commit? the terminal identity computation?) is not something to guess at, so every
 * phase reports its own duration here.
 *
 * Privacy: the event shape has **no** field for prompt text, context content, file
 * paths or attachment payloads. The only free-form values are a fixed phase name and a
 * provider **name** (e.g. `currentFile`, `codebase`, an MCP server name). Anything else
 * must be a number, a boolean or a closed enum. `submitLatency.test.ts` asserts this.
 *
 * Output: `console.debug` (invisible unless the webview console is set to verbose) plus
 * a bounded in-memory ring buffer that `__continueSubmitLatencyEvents()` dumps on demand,
 * so a report can be produced from a real workload without a rebuild.
 */

/** Fixed phase names. Keep them stable: they are the axis of any comparison. */
export type SubmitLatencyPhase =
  | "editor-processing"
  | "slash-rendering"
  | "context-resolution"
  | "submit-to-commit"
  | "commit-turn"
  | "save-enqueue"
  | "stream-start"
  | "terminal-commit"
  | "terminal-identity"
  | "terminal-save-enqueue";

export type SubmitLatencyEvent = {
  phase: SubmitLatencyPhase;
  sessionId: string;
  /** Wall time of the phase, when the phase is a span. */
  durationMs?: number;
  /** Context provider name (`currentFile`, `codebase`, a mention provider, …). */
  provider?: string;
  /** How many IPC requests the phase issued, when that is the point of the phase. */
  requests?: number;
  /** Whether the resolved turn actually carried context items. */
  hadContext?: boolean;
  /** Submit shape, so append and edit/resend can be compared separately. */
  insertion?: "append" | "replace";
  /** `false` for a phase that ended in an error (still useful: it explains a gap). */
  ok?: boolean;
};

const MAX_EVENTS = 40;
const events: SubmitLatencyEvent[] = [];

let consoleHelperInstalled = false;

/**
 * Exposes the ring buffer to the webview devtools console, so a report can be produced
 * by reproducing a send and then calling `__continueSubmitLatencyEvents()` — no rebuild,
 * no log level to change.
 */
function installConsoleHelper(): void {
  if (consoleHelperInstalled) {
    return;
  }
  consoleHelperInstalled = true;
  try {
    if (typeof window === "undefined") {
      return;
    }
    (
      window as unknown as Record<string, unknown>
    ).__continueSubmitLatencyEvents = () => readSubmitLatencyEvents();
  } catch {
    // ignore
  }
}

/**
 * Records one phase. Always cheap (a push + a `console.debug`) and never throws — an
 * instrumentation failure must not be able to break a send.
 */
export function recordSubmitLatency(event: SubmitLatencyEvent): void {
  try {
    events.push(event);
    if (events.length > MAX_EVENTS) {
      events.shift();
    }
    // `debug` level on purpose: hidden by default, available with verbose logging.
    console.debug("[submit-latency]", event);
    installConsoleHelper();
  } catch {
    // ignore
  }
}

/** The recent events, oldest first. For a support session / tests. */
export function readSubmitLatencyEvents(): readonly SubmitLatencyEvent[] {
  return events;
}

/** Test helper: drop everything recorded so far. */
export function resetSubmitLatencyEvents(): void {
  events.length = 0;
}

/**
 * Times an async span and records it, whatever the outcome: a phase that throws is
 * exactly the gap someone will be staring at in the log.
 */
export async function measureSubmitLatency<T>(
  event: Omit<SubmitLatencyEvent, "durationMs" | "ok">,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await run();
    recordSubmitLatency({
      ...event,
      durationMs: performance.now() - startedAt,
      ok: true,
    });
    return result;
  } catch (error) {
    recordSubmitLatency({
      ...event,
      durationMs: performance.now() - startedAt,
      ok: false,
    });
    throw error;
  }
}

/** Sync counterpart of `measureSubmitLatency`. */
export function measureSubmitLatencySync<T>(
  event: Omit<SubmitLatencyEvent, "durationMs" | "ok">,
  run: () => T,
): T {
  const startedAt = performance.now();
  try {
    const result = run();
    recordSubmitLatency({
      ...event,
      durationMs: performance.now() - startedAt,
      ok: true,
    });
    return result;
  } catch (error) {
    recordSubmitLatency({
      ...event,
      durationMs: performance.now() - startedAt,
      ok: false,
    });
    throw error;
  }
}
