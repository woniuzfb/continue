import { useAppDispatch, useAppSelector } from "../../redux/hooks";

import { retrySessionSave } from "../../redux/thunks/sessionPersistence";
import { Button } from "../ui";
import { useSessionId } from "./TipTapEditor/SessionScope";

/**
 * Save-failure recovery entry (方案.md §七.7): a failed save keeps the runtime,
 * keeps `dirty`, blocks trim/eviction and offers an explicit retry. The banner
 * only appears for the visible session's own persistence failure.
 */
export default function SessionSaveErrorBanner() {
  const dispatch = useAppDispatch();
  const sessionId = useSessionId();
  const persistence = useAppSelector((state) =>
    sessionId ? state.sessions.sessionsById[sessionId]?.persistence : undefined,
  );

  if (!sessionId || persistence?.state !== "failed") {
    return null;
  }

  return (
    <div className="border-border bg-input m-2 flex flex-col gap-2 rounded-md border border-solid p-3">
      <p className="text-error text-xs">
        {`Couldn't save this session${
          persistence.error?.code ? ` (${persistence.error.code})` : ""
        }: ${persistence.error?.message ?? "unknown error"}`}
      </p>
      <div className="flex flex-row items-center gap-2">
        <Button
          onClick={() => {
            void dispatch(retrySessionSave({ sessionId }));
          }}
        >
          Retry save
        </Button>
        <span className="text-description text-xs">
          Your changes are still in memory.
        </span>
      </div>
    </div>
  );
}
