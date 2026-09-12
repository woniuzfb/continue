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
 * must be a number, a boolean or a closed enum. `submitDiagnostics.test.ts` asserts this on
 * the printed lines themselves.
 *
 * Output: one `console.log` line per phase, prefixed `[submit-latency]`. Plain `log` on
 * purpose — `debug` is hidden in the VS Code webview console unless the level is switched
 * to Verbose, and a diagnostic nobody can see is not a diagnostic.
 */

/** Fixed phase names. Keep them stable: they are the axis of any comparison. */
export type SubmitLatencyPhase =
  | "editor-processing"
  | "slash-rendering"
  | "context-resolution"
  | "resolve-editor-content"
  | "target-resolution"
  | "history-load"
  | "history-merge"
  | "submit-pre-editor"
  | "submit-post-editor"
  | "submit-to-commit"
  | "commit-turn"
  | "save-enqueue"
  | "save-payload"
  | "save-attempt"
  | "main-thread-stall"
  | "save-request-sent"
  | "save-response-received"
  | "stream-start"
  | "terminal-commit"
  | "terminal-identity"
  | "terminal-save";

export type SubmitLatencyEvent = {
  phase: SubmitLatencyPhase;
  sessionId: string;
  /** Wall time of the phase, when the phase is a span. */
  durationMs?: number;
  /** Context provider name (`currentFile`, `codebase`, a mention provider, …). */
  provider?: string;
  /**
   * Code-level save reason (`USER_SUBMITTED`, `STREAM_CHECKPOINT:regular`, `retry`, …).
   * Never user content: it is the string the save queue already carries for diagnostics.
   */
  reason?: string;
  /** How many IPC requests the phase issued, when that is the point of the phase. */
  requests?: number;
  /**
   * Classification of the context requests the phase issued. Counted where the requests are
   * actually decided (`gatherContextItems`), not from the editor's mention list.
   */
  contextRequests?: {
    mentions: number;
    defaultProviders: number;
    currentFile: number;
    codebase: number;
  };
  /** Approximate size of a payload the phase built, in MB (cheap length sum, no copy). */
  payloadMB?: number;
  /**
   * Epoch milliseconds (same clock as the extension host). Durations alone cannot tell
   * whether a slow save was waiting before Core's handler started, inside it, or after it
   * answered; absolute timestamps on both sides can.
   */
  at?: number;
  /** Whether the resolved turn actually carried context items. */
  hadContext?: boolean;
  /** Submit shape, so append and edit/resend can be compared separately. */
  insertion?: "append" | "replace";
  /** `false` for a phase that ended in an error (still useful: it explains a gap). */
  ok?: boolean;
};

/**
 * Logging is **off by default**: diagnostics must not become permanent console noise. The
 * extension UI owns the switch (User Settings → "Show submit latency logs"), which is a
 * `config.ui` flag; `Chat` syncs it here.
 */
let loggingEnabled = false;

/** Called by the UI when the debug setting changes. */
export function setSubmitLatencyLoggingEnabled(enabled: boolean): void {
  loggingEnabled = enabled;
}

/** Whether the instrumentation currently prints. Exported for tests. */
export function isSubmitLatencyLoggingEnabled(): boolean {
  return loggingEnabled;
}

/**
 * Records one phase. Always cheap and never throws — an instrumentation failure must not
 * be able to break a send.
 *
 * The line is deliberately a single, greppable string: filter the webview console by
 * `submit-latency` and read the phases in order.
 *
 * `submit-to-commit` answers "how long after Enter did the bubble appear", and the phases
 * that precede it **partition** that span — `submit-pre-editor` + `resolve-editor-content`
 * + `submit-post-editor` should add up to it. A partition is what separates "an await of
 * ours is slow" from "the main thread was busy elsewhere": `resolve-editor-content` measures
 * the awaited call itself, the two `submit-*` phases measure everything around it.
 *
 * First real measurement, worth keeping in mind when reading these lines: the send that
 * produced `submit-to-commit 1322.8ms` had `context-resolution 0.2ms requests=0`, i.e. the
 * wait was **not** context IPC at all — which is exactly why the partition exists.
 */
export function recordSubmitLatency(event: SubmitLatencyEvent): void {
  if (!loggingEnabled) {
    return;
  }
  try {
    const details: string[] = [];
    if (event.durationMs !== undefined) {
      details.push(`${event.durationMs.toFixed(1)}ms`);
    }
    if (event.provider !== undefined) {
      details.push(`provider=${event.provider}`);
    }
    if (event.reason !== undefined) {
      details.push(`reason=${event.reason}`);
    }
    if (event.requests !== undefined) {
      details.push(`requests=${event.requests}`);
    }
    // Context requests are classified: a bare `requests=0` was misleading, because the
    // editor's own mentions are 0 even when `currentFile` / providers / codebase are hit.
    if (event.contextRequests !== undefined) {
      const { mentions, defaultProviders, currentFile, codebase } =
        event.contextRequests;
      details.push(
        `mentions=${mentions}`,
        `providers=${defaultProviders}`,
        `currentFile=${currentFile}`,
        `codebase=${codebase}`,
      );
    }
    if (event.payloadMB !== undefined) {
      details.push(`payloadMB=${event.payloadMB.toFixed(1)}`);
    }
    if (event.at !== undefined) {
      details.push(`at=${event.at}`);
    }
    if (event.insertion !== undefined) {
      details.push(event.insertion);
    }
    if (event.hadContext !== undefined) {
      details.push(`hadContext=${event.hadContext}`);
    }
    if (event.ok === false) {
      details.push("FAILED");
    }
    console.log(
      `[submit-latency] ${event.sessionId} ${event.phase}${details.length ? " " + details.join(" ") : ""}`,
    );
  } catch {
    // ignore
  }
}

const MAIN_THREAD_STALL_THRESHOLD_MS = 250;
const MAIN_THREAD_STALL_TICK_MS = 100;

/**
 * How long the main thread was blocked, given how long an interval actually took versus
 * how long it was asked to wait. Returns `undefined` for a healthy tick.
 *
 * Pure so it can be tested without a real stall; the timer below is a thin wrapper.
 */
export function stallFromTick(
  expectedMs: number,
  actualMs: number,
  thresholdMs = MAIN_THREAD_STALL_THRESHOLD_MS,
): number | undefined {
  const overrun = actualMs - expectedMs;
  return overrun >= thresholdMs ? overrun : undefined;
}

let stallTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Watches for main-thread stalls (workflow "submit latency and retry boundary").
 *
 * Why: a save response that the host answered in 8ms was observed taking 3446ms to reach
 * the GUI, and the whole 3.4s sat **after** Core had answered. Two mechanisms can do that —
 * the main thread being blocked, or the response queueing behind stream messages — and only
 * a stall clock can tell them apart. A timer that is late by a lot means the thread was not
 * running; if it stays on time, the delay is queueing, not blocking.
 *
 * Runs only while the debug switch is on.
 */
export function startMainThreadStallDetector(): void {
  if (stallTimer !== undefined) {
    return;
  }
  try {
    let last = performance.now();
    stallTimer = setInterval(() => {
      const now = performance.now();
      const stall = stallFromTick(MAIN_THREAD_STALL_TICK_MS, now - last);
      last = now;
      if (stall !== undefined) {
        recordSubmitLatency({
          phase: "main-thread-stall",
          sessionId: "-",
          durationMs: stall,
        });
      }
    }, MAIN_THREAD_STALL_TICK_MS);
  } catch {
    // ignore
  }
}

/** Stops the stall detector (idempotent). */
export function stopMainThreadStallDetector(): void {
  if (stallTimer !== undefined) {
    clearInterval(stallTimer);
    stallTimer = undefined;
  }
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
