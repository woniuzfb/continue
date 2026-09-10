import { BarsArrowUpIcon } from "@heroicons/react/24/outline";
import { chatMessageIsEmpty } from "core/llm/messages";
import { findLastIndex } from "core/util/findLast";
import { useMemo } from "react";
import { useMainEditor } from "../../../components/mainInput/TipTapEditor";
import { ToolbarButtonWithTooltip } from "../../../components/StyledMarkdownPreview/StepContainerPreToolbar/ToolbarButtonWithTooltip";
import { useSessionId } from "../../../components/mainInput/TipTapEditor/SessionScope";
import { useAppDispatch } from "../../../redux/hooks";
import { truncateSessionHistoryAfter } from "../../../redux/thunks/sessionChanges";
import {
  useSessionHistory,
  useSessionIsStreaming,
} from "../../../redux/selectors/sessionView";

/**
 * 方案.md §七.2/§十二: trim-to-here identifies its target by a stable message
 * id, never by a window index. The window can shrink (send-time trim), grow
 * (prepend) or be bubble-merged between render and click, so re-resolving
 * identity from an index inside the click handler is not reliable.
 */
export function ToolTruncateHistoryIcon({ messageId }: { messageId: string }) {
  const sessionId = useSessionId();
  const isStreaming = useSessionIsStreaming();
  const history = useSessionHistory();
  const lastMessageId = useMemo(() => {
    const index = findLastIndex(
      history,
      (item) => !chatMessageIsEmpty(item.message),
    );
    return index >= 0 ? history[index].message.id : undefined;
  }, [history]);
  const dispatch = useAppDispatch();
  const { mainEditor } = useMainEditor();

  if (messageId === lastMessageId) {
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
        // 方案.md §七.2: the mutation and its save boundary travel together —
        // otherwise the truncation would only reach disk on the next send or
        // tab switch, and would be lost on a reload.
        void dispatch(truncateSessionHistoryAfter({ sessionId, messageId }));
        mainEditor?.commands.focus();
      }}
    >
      <BarsArrowUpIcon
        className={`h-3 w-3 flex-shrink-0 opacity-60 ${isStreaming ? "cursor-not-allowed" : ""}`}
      />
    </ToolbarButtonWithTooltip>
  );
}
