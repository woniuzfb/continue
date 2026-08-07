import { useEffect } from "react";

import { Button, GhostButton } from "../../components";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { useAppDispatch } from "../../redux/hooks";
import { resolveStreamRetry } from "../../util/streamRetry";
import StreamErrorDialog from "./StreamError";

interface StreamErrorRetryDialogProps {
  error: unknown;
}

/**
 * Shown when the stream failed with a transient (potentially recoverable)
 * error. Lets the user choose between waiting and retrying (which re-runs
 * the message through the normal stream wrapper, preserving retry/backoff
 * semantics and error handling on subsequent failures) or disconnecting.
 *
 * If the dialog is closed by any other means (X / Escape / backdrop), the
 * cleanup resolves the pending choice as "disconnect" so the wrapper never
 * hangs.
 */
const StreamErrorRetryDialog = ({ error }: StreamErrorRetryDialogProps) => {
  const dispatch = useAppDispatch();

  useEffect(() => {
    return () => resolveStreamRetry("disconnect");
  }, []);

  const close = () => {
    dispatch(setShowDialog(false));
    dispatch(setDialogMessage(undefined));
  };

  return (
    <div className="flex flex-col gap-4 px-3 pb-3 pt-3">
      <StreamErrorDialog error={error} hideResubmit />

      <div className="border-border mt-2 flex items-center justify-end gap-2 border-t border-solid pt-3">
        <GhostButton
          onClick={() => {
            resolveStreamRetry("disconnect");
            close();
          }}
        >
          Disconnect
        </GhostButton>
        <Button
          onClick={() => {
            resolveStreamRetry("retry");
            close();
          }}
        >
          Retry
        </Button>
      </div>
    </div>
  );
};

export default StreamErrorRetryDialog;
