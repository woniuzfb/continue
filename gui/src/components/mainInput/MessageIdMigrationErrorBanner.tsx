import { useAppSelector } from "../../redux/hooks";
import type { MessageIdMigrationState } from "../../redux/slices/sessionsSlice";
import { useSessionId } from "./TipTapEditor/SessionScope";

/**
 * Legacy message ID migration failure (P4b-1, 方案.md §九.13).
 *
 * Deliberately a **separate** banner from `SessionSaveErrorBanner`: the two
 * facts have different meanings and different recovery semantics, so sharing
 * one banner would hide one behind the other.
 *
 *   history/save failed       → this conversation's content was not written
 *   message ID migration failed → the conversation is intact and usable; only
 *                                 the *disk identity* of its older messages was
 *                                 not upgraded, so stable targeting across a
 *                                 reload is not available yet
 *
 * Only `failed` renders here. `not-requested` / `pending` / `succeeded` are not
 * errors, and `unsupported` is the ordinary compatibility path for a host that
 * never declares the capability — showing it as a failure would report a
 * perfectly normal old host as a broken file.
 *
 * There is no retry action: the state machine allows exactly one attempt per
 * session, and a retry has to re-enter the single gate
 * (`scheduleMessageIdMigrationIfSafe`) rather than send a request from a
 * component, so a button here would either bypass the gate or lie.
 */

type FailedMigration = Extract<MessageIdMigrationState, { state: "failed" }>;

/**
 * Copy per failure code.
 *
 * Never renders `migration.message`: that is the raw Core error and may carry a
 * filesystem path or an internal stack fragment. The code is a stable enum, so
 * it identifies the recovery semantics without leaking anything.
 */
export function messageIdMigrationFailureCopy(
  code: FailedMigration["code"],
): string {
  switch (code) {
    case "SESSION_FILE_INVALID":
      return "This conversation's message identities could not be upgraded because its history file could not be read safely. The file was left unchanged.";
    case "MESSAGE_ID_MIGRATION_FAILED":
      return "This conversation's message identities could not be upgraded. The original history file was left unchanged.";
    case "REQUEST_TIMEOUT":
      return "The host did not finish upgrading this conversation's message identities. Your conversation remains available.";
  }
}

export default function MessageIdMigrationErrorBanner() {
  const sessionId = useSessionId();
  // Session-scoped on purpose (方案.md §九.0): this banner describes the session
  // of its own subtree, never the visible tab, so another tab's failure can
  // never show up here.
  const migration = useAppSelector((state) =>
    sessionId
      ? state.sessions.sessionsById[sessionId]?.messageIdMigration
      : undefined,
  );

  if (!sessionId || migration?.state !== "failed") {
    return null;
  }

  return (
    <div className="border-border bg-input m-2 flex flex-col gap-2 rounded-md border border-solid p-3">
      <p className="text-error text-xs">
        {`Message ID migration failed (${migration.code})`}
      </p>
      <span className="text-description text-xs">
        {messageIdMigrationFailureCopy(migration.code)}
      </span>
    </div>
  );
}
