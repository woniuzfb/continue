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
  | "SESSION_SAVE_FAILED"
  /**
   * `history/migrateIds` (legacy message ID stabilization P3) failed for a
   * reason other than an unreadable file — e.g. the in-lock array shape did not
   * match, or the atomic write failed. The original file is left untouched.
   * "Already migrated / nothing to do" is a **success** no-op, never this code.
   */
  | "MESSAGE_ID_MIGRATION_FAILED";

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
