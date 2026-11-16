import { useContext } from "react";
import { useStore } from "react-redux";
import { useSessionId } from "../components/mainInput/TipTapEditor/SessionScope";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch } from "../redux/hooks";
import { selectSessionHistory } from "../redux/selectors/sessionView";
import { selectSessionById } from "../redux/selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../redux/slices/sessionHistory";
import type { AppDispatch, RootState } from "../redux/store";
import {
  openSessionTab,
  refreshSessionCatalog,
} from "../redux/thunks/sessionLifecycle";
import { resolveHistoryMutationTarget } from "../redux/thunks/sessionPaging";
import { flushSessionSave } from "../redux/thunks/sessionPersistence";
import { windowToAbsoluteIndex } from "../redux/util/historyIndex";
import {
  carrierMessageIdOf,
  findGuiIndexContainingMessageId,
  windowHasUnsavedMerge,
} from "../redux/util/historyTarget";
import type { HistoryMutationTarget } from "./compactConversation";

function captureCarrierId(
  history: ChatHistoryItemWithMessageId[],
  target: HistoryMutationTarget,
): string | undefined {
  if ("messageId" in target) {
    return target.messageId;
  }
  const item = history[target.index];
  return item ? carrierMessageIdOf(item) : undefined;
}

async function resolveMutationTarget(
  dispatch: AppDispatch,
  getState: () => RootState,
  sessionId: string,
  windowIndex: number | undefined,
  targetMessageId: string,
): Promise<{ diskIndex: number; guiIndex: number } | undefined> {
  const session = selectSessionById(getState(), sessionId);
  if (!session) {
    return undefined;
  }
  const history = session.history;

  if (windowHasUnsavedMerge(history)) {
    return await dispatch(
      resolveHistoryMutationTarget({ sessionId, targetMessageId }),
    ).unwrap();
  }

  let winIdx = findGuiIndexContainingMessageId(history, targetMessageId);
  if (
    winIdx < 0 &&
    windowIndex !== undefined &&
    windowIndex >= 0 &&
    windowIndex < history.length
  ) {
    winIdx = windowIndex;
  }
  if (winIdx < 0 || winIdx >= history.length) {
    return undefined;
  }
  const liveOffset = session.pagination.truncated
    ? (session.pagination.loadedOffset ?? 0)
    : 0;
  const diskIndex = windowToAbsoluteIndex(liveOffset, winIdx);
  return { diskIndex, guiIndex: winIdx };
}

export const useForkConversation = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const store = useStore<RootState>();
  const sessionId = useSessionId();

  return async (target: HistoryMutationTarget) => {
    const windowHistory = selectSessionHistory(store.getState(), sessionId);
    const targetMessageId = captureCarrierId(windowHistory, target);
    if (targetMessageId === undefined) {
      console.warn("forkConversation: 目标消息不在已加载的窗口中，已中止");
      return;
    }

    await dispatch(flushSessionSave({ sessionId }));

    const resolved = await resolveMutationTarget(
      dispatch,
      store.getState,
      sessionId,
      "index" in target ? target.index : undefined,
      targetMessageId,
    );
    if (!resolved) {
      console.warn("forkConversation: 无法在磁盘上定位目标消息，已中止");
      return;
    }

    const result = await ideMessenger.request("conversation/fork", {
      index: resolved.diskIndex,
      sessionId,
      targetMessageId,
    });
    if (result?.status === "success" && result.content) {
      const currentTitle = selectSessionById(
        store.getState(),
        sessionId,
      )?.title;
      const fallbackTitle = `${currentTitle || "Session"} (Fork)`;
      await dispatch(refreshSessionCatalog({}));
      await dispatch(
        openSessionTab({
          sessionId: result.content.sessionId,
          title: result.content.title || fallbackTitle,
        }),
      );
    }
  };
};
