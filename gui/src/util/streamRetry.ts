/**
 * Promise bridge between the stream retry dialog (UI) and the stream thunk
 * wrapper (which runs the retry loop). The dialog's buttons resolve the
 * pending promise; any other close path (X / Escape / backdrop) unmounts the
 * dialog, and the component's cleanup resolves it as "disconnect" — so the
 * wrapper can never hang waiting for a choice.
 */
export type StreamRetryChoice = "retry" | "disconnect";

let pendingResolver: ((choice: StreamRetryChoice) => void) | null = null;

export function waitForStreamRetryChoice(): Promise<StreamRetryChoice> {
  return new Promise((resolve) => {
    pendingResolver = resolve;
  });
}

export function resolveStreamRetry(choice: StreamRetryChoice): void {
  pendingResolver?.(choice);
  pendingResolver = null;
}
