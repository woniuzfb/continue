import { useEffect } from "react";
import { useAppDispatch } from "../redux/hooks";
import { flushAllPendingSessions } from "../redux/thunks/sessionPersistence";

/**
 * 方案.md §七.12 (Shutdown / Unload).
 *
 * A webview unload, extension deactivate or host shutdown cannot await async
 * IPC, so this is best-effort only: it pushes every dirty session through the
 * *normal* save path (per-session queue → `history/save` → Core merge/lock/
 * atomic write). It deliberately does not mark anything clean, does not clear
 * `dirty`, does not bump `persistedRevision` and is not used as proof that a
 * trim succeeded — recovery still comes from the saves and checkpoints that
 * already succeeded during normal operation.
 *
 * There is intentionally no synchronous write bypass here.
 */
export function useUnloadFlush(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const flush = () => {
      try {
        void dispatch(flushAllPendingSessions());
      } catch (e) {
        // Unload must never throw: the last successful save is the guarantee.
        console.error("unload flush failed", e);
      }
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [dispatch]);
}
