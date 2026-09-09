import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectActiveSessionId } from "../../redux/selectors/sessionView";
import {
  dismissInterruptedSession,
  retryInterruptedSession,
} from "../../redux/thunks/sessionInterruption";
import { Button } from "../ui";

/**
 * Restart recovery entry (方案.md §八): a loaded session whose turn was cut off
 * cannot be resumed, so the user either retries (new requestId, stale calls
 * superseded) or dismisses (stale calls canceled and saved).
 */
export default function InterruptedSessionBanner() {
  const dispatch = useAppDispatch();
  const sessionId = useAppSelector(selectActiveSessionId);
  const interrupted = useAppSelector((state) =>
    sessionId ? state.sessions.sessionsById[sessionId]?.interrupted : undefined,
  );

  if (!sessionId || !interrupted) {
    return null;
  }

  return (
    <div className="border-border bg-input m-2 flex flex-col gap-2 rounded-md border border-solid p-3">
      <p className="text-description text-xs">
        This turn was interrupted. Its tool calls can no longer be approved.
      </p>
      <div className="flex flex-row items-center gap-2">
        <Button
          onClick={() => {
            void dispatch(retryInterruptedSession({ sessionId }));
          }}
        >
          Retry
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            void dispatch(dismissInterruptedSession({ sessionId }));
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
