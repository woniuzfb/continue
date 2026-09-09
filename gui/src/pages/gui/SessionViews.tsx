import React from "react";
import { useAppSelector } from "../../redux/hooks";
import {
  selectActiveSessionId,
  selectTabOrder,
} from "../../redux/selectors/sessions";
import { MainEditorProvider } from "../../components/mainInput/TipTapEditor";
import { SessionScope } from "../../components/mainInput/TipTapEditor/SessionScope";
import { Chat } from "./Chat";

/**
 * 方案.md §九.1/§九.2: every open tab stays mounted with its own editor and its
 * own session scope. `display: none` keeps inactive trees out of layout and
 * paint without unmounting them, so undo stacks, selections and plugin state
 * survive a tab switch.
 *
 * The session identity is passed explicitly: a `SessionScope` carries the
 * `sessionId` (never a faked Redux store), every session-scoped selector reads
 * `sessionsById[sessionId]`, and every action/thunk still carries the id in its
 * payload. `activeSessionId` keeps exactly one real meaning: the visible tab.
 */

const MemoizedChat = React.memo(Chat);

function SessionTab({ sessionId }: { sessionId: string }) {
  return (
    <SessionScope sessionId={sessionId}>
      <MainEditorProvider sessionId={sessionId}>
        <MemoizedChat />
      </MainEditorProvider>
    </SessionScope>
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
