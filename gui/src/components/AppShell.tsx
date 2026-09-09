import { useAppSelector } from "../redux/hooks";
import { selectActiveIsInEdit } from "../redux/selectors/sessionView";
import { History } from "./History";
import { TabBar } from "./TabBar/TabBar";
import { SessionViews } from "../pages/gui/SessionViews";

/**
 * 方案.md §九.0: the shell around the session tabs.
 *
 * It owns the global, session-independent UI — the history sidebar and the tab
 * bar — and maps `tabOrder` to per-tab `SessionLayout` trees. It must never
 * depend on a tab's `MainEditorProvider` or on any session-scoped hook: the
 * tab bar therefore always reflects the real active session, and the shell
 * stays usable before the first tab exists (`SessionViews` renders the
 * bootstrap placeholder in that case).
 *
 * The only active-session reads allowed here are the ones that decide *which*
 * tab is visible (`selectActiveIsInEdit`, and the tab projection inside
 * `TabBar`/`SessionViews`).
 */
export function AppShell() {
  const showSessionTabs = useAppSelector(
    (state) => state.config.config.ui?.showSessionTabs,
  );
  const isInEdit = useAppSelector(selectActiveIsInEdit);

  return (
    <div className="flex min-h-0 w-full flex-row overflow-hidden">
      <aside className="4xl:flex border-vsc-input-border no-scrollbar hidden min-h-0 w-96 overflow-y-auto border-0 border-r border-solid">
        <History />
      </aside>
      <main className="no-scrollbar flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The tab bar belongs to the shell, never to a tab's provider, so it
            always shows the real active session. */}
        {!!showSessionTabs && !isInEdit && <TabBar />}
        <SessionViews />
      </main>
    </div>
  );
}
