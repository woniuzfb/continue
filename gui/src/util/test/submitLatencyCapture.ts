import { vi } from "vitest";
import {
  isSubmitLatencyLoggingEnabled,
  setSubmitLatencyLoggingEnabled,
  type SubmitLatencyEvent,
} from "../submitLatency";

/**
 * Captures the `[submit-latency]` lines the app prints.
 *
 * The instrumentation prints with `console.log` (visible in the VS Code webview console by
 * default), so the tests assert on exactly the text a user would paste into a bug report —
 * which also makes the privacy assertions meaningful: they check what actually leaves the
 * machine, not an internal buffer.
 */
export function captureSubmitLatencyLines() {
  const lines: string[] = [];
  // The instrumentation is off by default (a `config.ui` debug switch owns it), so a test
  // that wants the lines has to turn it on — exactly like the UI does.
  const wasEnabled = isSubmitLatencyLoggingEnabled();
  setSubmitLatencyLoggingEnabled(true);
  const spy = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
    const line = String(args[0] ?? "");
    if (line.startsWith("[submit-latency]")) {
      lines.push(line);
    }
  });

  return {
    lines: () => [...lines],
    /** The captured lines, parsed back into the event shape the app records. */
    events: (): SubmitLatencyEvent[] =>
      lines.map((line) => {
        const [, sessionId, phase, ...details] = line.split(" ");
        const event: any = { sessionId, phase };
        for (const detail of details) {
          if (detail === "append" || detail === "replace") {
            event.insertion = detail;
            continue;
          }
          if (detail === "FAILED") {
            event.ok = false;
            continue;
          }
          if (detail.endsWith("ms") && !detail.includes("=")) {
            event.durationMs = Number(detail.slice(0, -"ms".length));
            continue;
          }
          const separator = detail.indexOf("=");
          if (separator < 0) {
            continue;
          }
          const key = detail.slice(0, separator);
          const value = detail.slice(separator + 1);
          if (key === "provider") event.provider = value;
          else if (key === "requests") event.requests = Number(value);
          else if (key === "hadContext") event.hadContext = value === "true";
        }
        return event;
      }),
    restore: () => {
      spy.mockRestore();
      setSubmitLatencyLoggingEnabled(wasEnabled);
    },
  };
}
