import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import type { PendingSubmission } from "../slices/sessionsSlice";
import { windowItemContainsMessageId } from "./historyTarget";

/**
 * Where an append-shaped draft is shown: after the last history item.
 *
 * A `replace` draft is shown at its target instead — see `pendingSubmissionTargetIndex` —
 * because appending it to the tail would make an edit/resend look like a new message.
 */
export function pendingSubmissionTargetIndex(
  history: ChatHistoryItemWithMessageId[],
  pending: PendingSubmission | undefined,
): number {
  if (!pending || pending.insertion.kind !== "replace") {
    return -1;
  }
  // Once committed there is nothing to overlay: the committed turn replaced the target, and
  // the bubble carries its own border (方案.md §7.2.5).
  if (pending.status !== "resolving-context") {
    return -1;
  }
  // Destructured so the narrowing survives into the callback.
  const { targetMessageId } = pending.insertion;
  return history.findIndex((item) =>
    windowItemContainsMessageId(item, targetMessageId),
  );
}

/** Should the draft row be rendered at all? Only while the turn does not exist yet. */
export function shouldRenderPendingSubmission(
  pending: PendingSubmission | undefined,
): boolean {
  return pending?.status === "resolving-context";
}

/** Text to render in the draft bubble. Never includes attachment payloads. */
export function pendingSubmissionText(pending: PendingSubmission): string {
  const content = pending.displayContent;
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}
