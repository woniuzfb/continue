import { History } from "../../components/History";
import { TabBar } from "../../components/TabBar/TabBar";
import { useAppSelector } from "../../redux/hooks";
import { selectActiveIsInEdit } from "../../redux/selectors/sessionView";
import { SessionViews } from "./SessionViews";

export default function GUI() {
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
        {/* 方案.md §九.0: the tab bar belongs to the shell, never to a tab's
            provider, so it always shows the real active session. */}
        {!!showSessionTabs && !isInEdit && <TabBar />}
        <SessionViews />
      </main>
    </div>
  );
}
