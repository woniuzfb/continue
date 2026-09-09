import { BarsArrowUpIcon } from "@heroicons/react/24/outline";
import { chatMessageIsEmpty } from "core/llm/messages";
import { findLastIndex } from "core/util/findLast";
import { useMemo } from "react";
import { useMainEditor } from "../../../components/mainInput/TipTapEditor";
import { ToolbarButtonWithTooltip } from "../../../components/StyledMarkdownPreview/StepContainerPreToolbar/ToolbarButtonWithTooltip";
import { useAppDispatch } from "../../../redux/hooks";
import { useSessionId } from "../../../components/mainInput/TipTapEditor/SessionScope";
import { useStore } from "react-redux";
import type { RootState } from "../../../redux/store";
import { truncateHistoryAfterMessageId } from "../../../redux/slices/sessionsSlice";
import {
  useSessionHistory,
  useSessionIsStreaming,
} from "../../../redux/selectors/sessionView";
import {} from "../../../redux/selectors/sessionView";

export function ToolTruncateHistoryIcon({
  historyIndex,
}: {
  historyIndex: number;
}) {
  const sessionId = useSessionId();
  const isStreaming = useSessionIsStreaming();
  const history = useSessionHistory();
  const lastMessageIndex = useMemo(() => {
    return findLastIndex(history, (item) => !chatMessageIsEmpty(item.message));
  }, [history]);
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const { mainEditor } = useMainEditor();

  if (historyIndex === lastMessageIndex) {
    // filler so doesn't jump in
    return <div className="h-3 w-3" />;
  }

  return (
    <ToolbarButtonWithTooltip
      tooltipContent={isStreaming ? "" : "Trim chat to this message"}
      onClick={() => {
        if (isStreaming) {
          return;
        }
        const messageId = history[historyIndex]?.message.id;
        if (messageId) {
          dispatch(
            truncateHistoryAfterMessageId({
              sessionId,
              messageId,
            }),
          );
        }
        mainEditor?.commands.focus();
      }}
    >
      <BarsArrowUpIcon
        className={`h-3 w-3 flex-shrink-0 opacity-60 ${isStreaming ? "cursor-not-allowed" : ""}`}
      />
    </ToolbarButtonWithTooltip>
  );
}
