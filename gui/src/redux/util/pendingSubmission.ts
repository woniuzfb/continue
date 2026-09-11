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
  // Destructured so the narrowing survives into the callback.
  const { targetMessageId } = pending.insertion;
  return history.findIndex((item) =>
    windowItemContainsMessageId(item, targetMessageId),
  );
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
