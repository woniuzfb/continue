import { useEffect, useRef } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  ensureActiveSessionLoaded,
  refreshSessionCatalog,
} from "../../redux/thunks/sessionLifecycle";

/**
 * 方案.md §五.16/§九: `SessionViews` must never render `Chat` without a
 * `SessionScope` (Chat calls `useSessionId()`, which throws). When the store has
 * no tab yet — first boot before rehydration/bootstrap, or after the last tab
 * was closed — this placeholder is rendered instead, and the startup pipeline
 * loads or creates the first session.
 *
 * `ensureActiveSessionLoaded` is idempotent (single in-flight run), so racing
 * with the config-load path in `ParallelListeners` is safe.
 */
export function SessionBootstrapView() {
  const dispatch = useAppDispatch();
  const catalogLoading = useAppSelector(
    (state) => state.sessionCatalog.isLoading,
  );
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void dispatch(ensureActiveSessionLoaded());
  }, [dispatch]);

  return (
    <div
      className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3"
      data-testid="session-bootstrap"
    >
      <span className="text-description">Loading session…</span>
      <button
        type="button"
        className="text-description cursor-pointer text-xs underline hover:brightness-125"
        onClick={() => {
          void dispatch(refreshSessionCatalog({}));
          void dispatch(ensureActiveSessionLoaded());
        }}
      >
        {catalogLoading ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
