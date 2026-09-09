/**
 * Structured error codes for session persistence (Phase 0.1).
 *
 * GUI must branch on `code`, never on error strings. The code travels from
 * Core (where the session file lives) to the GUI through the webview error
 * response as an optional `errorCode` field.
 */
export type SessionPersistenceErrorCode =
  | "TRUNCATED_OFFSET_INVALID"
  | "TRUNCATED_BASELINE_MISSING"
  | "SESSION_FILE_INVALID"
  | "SESSION_SAVE_FAILED";

export class SessionPersistenceError extends Error {
  constructor(
    public readonly code: SessionPersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionPersistenceError";
  }
}
