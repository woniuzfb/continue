import { useEffect, useState } from "react";
import type { PendingSubmission } from "../../redux/slices/sessionsSlice";
import { pendingSubmissionText } from "../../redux/util/pendingSubmission";
import { AnimatedEllipsis } from "../AnimatedEllipsis";

/**
 * The pending draft row of a send that is still being prepared (workflow "submit latency
 * and retry boundary", step 3).
 *
 * Stage 2F commits the submitted turn only after the editor content has been resolved, and
 * that resolution awaits context IPC — so the bubble used to appear about a second after
 * Enter. This row is that missing feedback: it renders the text the user already typed, in
 * the place the committed turn will occupy, while the turn is being prepared.
 *
 * It is **not** a history item: no message id, no save payload, no metrics, and it cannot
 * be clicked, edited or copied as if it were content. `attachmentMeta` renders file-name
 * chips only (never the payload), matching how a committed user bubble looks.
 */
export function PendingSubmissionItem({
  pending,
}: {
  pending: PendingSubmission;
}) {
  const text = pendingSubmissionText(pending);
  const elapsedSeconds = useElapsedSeconds(pending.startedAt);

  return (
    <div
      className="thread-message px-2 py-1"
      data-pending-submission={pending.submissionId}
    >
      <div className="border-description/40 bg-input rounded-md border border-dashed px-2 py-1">
        <div className="text-description-muted flex items-center gap-1 text-xs">
          <span>
            Preparing
            <AnimatedEllipsis />
          </span>
          {elapsedSeconds >= 1 && <span>{elapsedSeconds}s</span>}
          <span className="italic">not sent yet</span>
        </div>
        {text && (
          <div className="text-foreground whitespace-pre-wrap text-sm">
            {text}
          </div>
        )}
        {pending.attachmentMeta && pending.attachmentMeta.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {pending.attachmentMeta.map((attachment, index) => (
              <span
                key={`${attachment.path}-${index}`}
                className="bg-description/20 text-description rounded px-1 text-xs"
              >
                {attachment.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Whole seconds since the send started; 0 until the first second has elapsed. */
function useElapsedSeconds(startedAt: number): number {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 500);
    return () => clearInterval(timer);
  }, [startedAt]);

  return elapsed;
}
