/**
 * Typed timeout for `IdeMessenger.request` (P4a of the legacy message-ID work).
 *
 * A host that does not recognise a `messageType` never responds at all (VS Code
 * simply has no handler, IntelliJ logs "Unknown message type" — neither calls
 * `respond`), so the request promise would otherwise stay pending forever and
 * its `window` "message" listener would never be removed. `request` therefore
 * accepts an optional `timeoutMs` and rejects with this error, removing the
 * listener first.
 *
 * Branch on `code`, never on the message text.
 */
export class IdeRequestTimeoutError extends Error {
  readonly code = "IDE_REQUEST_TIMEOUT";

  constructor(
    public readonly messageType: string,
    public readonly timeoutMs: number,
  ) {
    super(`IDE request "${messageType}" timed out after ${timeoutMs}ms`);
    this.name = "IdeRequestTimeoutError";
  }
}

export function isIdeRequestTimeoutError(
  error: unknown,
): error is IdeRequestTimeoutError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "IDE_REQUEST_TIMEOUT"
  );
}
