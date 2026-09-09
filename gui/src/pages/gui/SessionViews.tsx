import React from "react";
import { Provider, useStore } from "react-redux";
import { useAppSelector } from "../../redux/hooks";
import {
  selectActiveSessionId,
  selectTabOrder,
} from "../../redux/selectors/sessions";
import { getSessionScopedStore } from "../../redux/sessionScopedStore";
import type { RootState } from "../../redux/store";
import { MainEditorProvider } from "../../components/mainInput/TipTapEditor";
import { Chat } from "./Chat";

/**
 * 方案.md §九.1/§九.2: every open tab stays mounted with its own editor and its
 * own session view. `display: none` keeps the inactive trees out of layout and
 * paint without unmounting them, so undo stacks, selections and plugin state
 * survive a tab switch. Each tree reads a session-scoped store facade, so its
 * selectors only ever see that tab's session.
 */

const MemoizedChat = React.memo(Chat);

function SessionTab({ sessionId }: { sessionId: string }) {
  const realStore = useStore<RootState>();
  const scopedStore = getSessionScopedStore(realStore, sessionId);

  return (
    <Provider store={scopedStore as any}>
      <MainEditorProvider sessionId={sessionId}>
        <MemoizedChat />
      </MainEditorProvider>
    </Provider>
  );
}

const MemoizedSessionTab = React.memo(SessionTab);

export function SessionViews() {
  const tabOrder = useAppSelector(selectTabOrder);
  const activeSessionId = useAppSelector(selectActiveSessionId);

  if (tabOrder.length === 0) {
    // Before the first session is bootstrapped there is nothing to scope.
    return <MemoizedChat />;
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
          <MemoizedSessionTab sessionId={sessionId} />
        </div>
      ))}
    </>
  );
}
