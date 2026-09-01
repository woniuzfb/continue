import { ChatHistoryItem } from "core";
import { renderChatMessage, stripImages } from "core/util/messageContent";
import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { useAppSelector } from "../../redux/hooks";
import { selectUIConfig } from "../../redux/slices/configSlice";
import { deleteMessage } from "../../redux/slices/sessionSlice";
import ThinkingBlockPeek from "../mainInput/belowMainInput/ThinkingBlockPeek";
import StyledMarkdownPreview from "../StyledMarkdownPreview";
import ConversationSummary from "./ConversationSummary";
import ResponseActions from "./ResponseActions";
import ThinkingIndicator from "./ThinkingIndicator";

interface StepContainerProps {
  item: ChatHistoryItem;
  index: number;
  isLast: boolean;
  latestSummaryIndex?: number;
  actionsOnly?: boolean;
}

export default function StepContainer(props: StepContainerProps) {
  const dispatch = useDispatch();
  const [isTruncated, setIsTruncated] = useState(false);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const uiConfig = useAppSelector(selectUIConfig);

  // Calculate dimming and indicator state based on latest summary index
  const latestSummaryIndex = props.latestSummaryIndex ?? -1;
  const isBeforeLatestSummary =
    latestSummaryIndex !== -1 && props.index <= latestSummaryIndex;
  const isLatestSummary =
    latestSummaryIndex !== -1 && props.index === latestSummaryIndex;

  const historyItemAfterThis = useAppSelector(
    (state) => state.session.history[props.index + 1],
  );
  // 只有当工具调用仍在进行（generating/generated/calling）时才隐藏按钮。
  // 流被中断后，clearDanglingMessages 会把悬空的工具调用标记为 canceled/errored，
  // 此时 toolCallStates 仍是非空数组，若直接判断 truthy 会导致按钮永久消失。
  const hasActiveToolCalls = !!props.item.toolCallStates?.some(
    (toolCall) =>
      toolCall.status === "generating" ||
      toolCall.status === "generated" ||
      toolCall.status === "calling",
  );

  const showResponseActions =
    (props.isLast || historyItemAfterThis?.message.role === "user") &&
    !(props.isLast && (isStreaming || hasActiveToolCalls));

  useEffect(() => {
    if (!isStreaming) {
      const content = renderChatMessage(props.item.message).trim();
      const endingPunctuation = [".", "?", "!", "```", ":"];

      // If not ending in punctuation or emoji, we assume the response got truncated
      if (
        content.trim() !== "" &&
        !(
          endingPunctuation.some((p) => content.endsWith(p)) ||
          /\p{Emoji}/u.test(content.slice(-2))
        )
      ) {
        setIsTruncated(true);
      } else {
        setIsTruncated(false);
      }
    }
  }, [props.item.message.content, isStreaming]);

  function onDelete() {
    dispatch(deleteMessage(props.index));
  }

  function onContinueGeneration() {
    window.postMessage(
      {
        messageType: "userInput",
        data: {
          input: "Continue your response exactly where you left off:",
        },
      },
      "*",
    );
  }

  return (
    <div className="w-full max-w-full">
      {!props.actionsOnly && (
        <div
          className={`bg-background min-w-0 max-w-full p-1 px-1.5 ${isBeforeLatestSummary ? "opacity-35" : ""}`}
        >
          {uiConfig?.displayRawMarkdown ? (
            <pre className="text-2xs max-w-full overflow-x-auto whitespace-pre-wrap break-words p-4">
              {renderChatMessage(props.item.message)}
            </pre>
          ) : (
            <>
              {props.item.reasoning?.text?.trim() && (
                <ThinkingBlockPeek
                  content={props.item.reasoning.text}
                  index={props.index}
                  prevItem={props.index > 0 ? props.item : null}
                  inProgress={!props.item.reasoning?.endAt}
                />
              )}

              <StyledMarkdownPreview
                isRenderingInStepContainer
                source={stripImages(props.item.message.content)}
                itemIndex={props.index}
              />
            </>
          )}
          {props.isLast && <ThinkingIndicator historyItem={props.item} />}
        </div>
      )}

      {showResponseActions && (
        <div
          className={`mt-2 h-7 transition-opacity duration-300 ease-in-out ${isBeforeLatestSummary || isStreaming ? "opacity-35" : ""} ${isStreaming && "pointer-events-none cursor-not-allowed"}`}
        >
          <ResponseActions
            isTruncated={isTruncated}
            onDelete={onDelete}
            onContinueGeneration={onContinueGeneration}
            index={props.index}
            item={props.item}
            isLast={props.isLast}
          />
        </div>
      )}

      {/* Show compaction indicator for the latest summary */}
      {!props.actionsOnly && isLatestSummary && (
        <div className="mx-1.5 my-5">
          <div className="flex items-center">
            <div className="border-border flex-1 border-t border-solid"></div>
            <span className="text-description mx-3 text-xs">
              Previous Conversation Compacted
            </span>
            <div className="border-border flex-1 border-t border-solid"></div>
          </div>
        </div>
      )}

      {/* ConversationSummary is outside the dimmed container so it's always at full opacity */}
      {!props.actionsOnly && (
        <ConversationSummary item={props.item} index={props.index} />
      )}
    </div>
  );
}
