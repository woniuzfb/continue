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
  | "history-hydration"
  | "submit-pre-editor"
  | "submit-post-editor"
  | "submit-to-commit"
  | "commit-turn"
  | "save-enqueue"
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
  /** How many IPC requests the phase issued, when that is the point of the phase. */
  requests?: number;
  /** Whether the resolved turn actually carried context items. */
  hadContext?: boolean;
  /** Submit shape, so append and edit/resend can be compared separately. */
  insertion?: "append" | "replace";
  /** `false` for a phase that ended in an error (still useful: it explains a gap). */
  ok?: boolean;
};

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
  try {
    const details: string[] = [];
    if (event.durationMs !== undefined) {
      details.push(`${event.durationMs.toFixed(1)}ms`);
    }
    if (event.provider !== undefined) {
      details.push(`provider=${event.provider}`);
    }
    if (event.requests !== undefined) {
      details.push(`requests=${event.requests}`);
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
