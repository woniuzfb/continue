import React from "react";
import { useAppSelector } from "../../redux/hooks";
import {
  selectActiveSessionId,
  selectTabOrder,
} from "../../redux/selectors/sessions";
import { SessionBootstrapView } from "./SessionBootstrapView";
import { SessionLayout } from "../../components/SessionLayout";

/**
 * 方案.md §九.1/§九.2: every open tab stays mounted with its own editor and its
 * own session scope. `display: none` keeps inactive trees out of layout and
 * paint without unmounting them, so undo stacks, selections and plugin state
 * survive a tab switch.
 *
 * This component only maps `tabOrder` to per-tab `SessionLayout` trees; the
 * scope, the editor provider and the tab-local UI live there.
 */
export function SessionViews() {
  const tabOrder = useAppSelector(selectTabOrder);
  const activeSessionId = useAppSelector(selectActiveSessionId);

  if (tabOrder.length === 0) {
    // Never render a bare `Chat`: it calls `useSessionId()`, which throws
    // outside a SessionScope. The placeholder runs the startup pipeline.
    return <SessionBootstrapView />;
  }

  return (
    <>
      {tabOrder.map((sessionId) => (
        <div
          key={sessionId}
          className="flex min-h-0 w-full flex-1 flex-col"
          style={{
            display: sessionId === activeSessionId ? "flex" : "none",
          }}
        >
          <SessionLayout sessionId={sessionId} />
        </div>
      ))}
    </>
  );
}
