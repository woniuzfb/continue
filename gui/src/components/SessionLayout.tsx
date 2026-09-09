import React from "react";
import { MainEditorProvider } from "./mainInput/TipTapEditor";
import { SessionScope } from "./mainInput/TipTapEditor/SessionScope";
import { Chat } from "../pages/gui/Chat";

/**
 * 方案.md §九.0: the per-tab boundary.
 *
 * Everything inside belongs to exactly one session: `SessionScope` supplies the
 * id, `MainEditorProvider` owns that tab's editor instance, and `Chat` renders
 * the tab-local UI (messages, main editor, tool bars, banners). No component in
 * this subtree may read the *visible* session — that is what the shell
 * (`AppShell`) is for, and `sessionScopeGate.test.ts` enforces it.
 */
const MemoizedChat = React.memo(Chat);

export const SessionLayout = React.memo(function SessionLayout({
  sessionId,
}: {
  sessionId: string;
}) {
  return (
    <SessionScope sessionId={sessionId}>
      <MainEditorProvider sessionId={sessionId}>
        <MemoizedChat />
      </MainEditorProvider>
    </SessionScope>
  );
});
