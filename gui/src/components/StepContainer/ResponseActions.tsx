import {
  ArrowsPointingInIcon,
  BarsArrowDownIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { ChatHistoryItem } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { useAppSelector } from "../../redux/hooks";
import { useCompactConversation } from "../../util/compactConversation";
import { FeedbackButtons } from "../FeedbackButtons";
import { CopyIconButton } from "../gui/CopyIconButton";
import HeaderButtonWithToolTip from "../gui/HeaderButtonWithToolTip";

export interface ResponseActionsProps {
  isTruncated: boolean;
  onContinueGeneration: () => void;
  index: number;
  onDelete: () => void;
  item: ChatHistoryItem;
  isLast: boolean;
}

export default function ResponseActions({
  onContinueGeneration,
  index,
  item,
  isTruncated,
  onDelete,
  isLast,
}: ResponseActionsProps) {
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const isPruned = useAppSelector((state) => state.session.isPruned);
  const history = useAppSelector((state) => state.session.history);
  const excludeThinkingFromCopy = useAppSelector(
    (state) => state.config.config?.ui?.excludeThinkingFromCopy ?? true,
  );

  /**
   * 复制整个回复组（同一轮次内连续的 assistant/thinking 条目），而不是只复制
   * 当前条目：即使该轮次没有被合并（例如首轮豁免、或旧会话尚未重载），复制
   * 按钮也能拿到完整正文。组装方式与 mergeSplitReplies 保持一致——思考文本
   * 在前（\n\n 分隔），所有 assistant 正文按流序精确拼接——这样“已合并”和
   * “未合并”的轮次复制出来完全相同。
   *
   * excludeThinkingFromCopy=true（默认）时跳过所有思考块（role:"thinking"
   * 条目 + assistant 上的内联 reasoning），只复制正文。
   */
  const copyText = () => {
    // 回溯到本轮的起点（上一条 user/tool 消息之后）
    const turnItems: ChatHistoryItem[] = [];
    let i = index;
    while (i >= 0 && history[i]) {
      const role = history[i].message.role;
      if (role === "user" || role === "tool" || role === "system") {
        break;
      }
      turnItems.push(history[i]);
      i--;
    }
    turnItems.reverse(); // 恢复时间顺序

    const thinkingParts: string[] = [];
    const contentParts: string[] = [];

    for (const turnItem of turnItems) {
      if (turnItem.message.role === "thinking") {
        if (excludeThinkingFromCopy) {
          continue;
        }
        const t = renderChatMessage(turnItem.message).trim();
        if (t) {
          thinkingParts.push(t);
        }
      } else if (turnItem.message.role === "assistant") {
        // 收集每个 assistant 条目的内联 reasoning（<think> 路径）。
        // 与 mergeSplitReplies 一致：所有思考文本在前，正文在后。
        // 未合并场景下同一轮可能有多条 assistant 各自带 reasoning，
        // 全部收集才能保证复制内容完整。
        if (!excludeThinkingFromCopy) {
          const r = turnItem.reasoning?.text?.trim();
          if (r) {
            thinkingParts.push(r);
          }
        }
        const c = renderChatMessage(turnItem.message);
        if (c) {
          contentParts.push(c);
        }
      }
    }

    const thinking = thinkingParts.join("\n\n");
    const content = contentParts.join("");
    if (thinking && content) {
      return `${thinking}\n\n${content}`;
    }
    return thinking || content;
  };

  const percent = Math.round((contextPercentage ?? 0) * 100);
  const buttonColorClass =
    isLast && (isPruned || percent > 80)
      ? "text-warning"
      : "text-description-muted";

  const showLabel = isLast && (isPruned || percent >= 60);

  const compactConversation = useCompactConversation();

  return (
    <div className="text-description-muted mx-2 flex cursor-default items-center justify-end space-x-1 bg-transparent pb-0 text-xs">
      <HeaderButtonWithToolTip
        testId={`compact-button-${index}`}
        text={
          showLabel
            ? "Summarize conversation to reduce context length"
            : "Compact conversation"
        }
        tabIndex={-1}
        onClick={() => compactConversation(index)}
      >
        <div className="flex items-center space-x-1">
          <ArrowsPointingInIcon
            className={`h-3.5 w-3.5 ${buttonColorClass || "text-description-muted"}`}
          />
          {showLabel && (
            <span
              className={`text-xs ${buttonColorClass || "text-description-muted"}`}
            >
              Compact conversation
            </span>
          )}
        </div>
      </HeaderButtonWithToolTip>

      {isTruncated && (
        <HeaderButtonWithToolTip
          tabIndex={-1}
          text="Continue generation"
          onClick={onContinueGeneration}
        >
          <BarsArrowDownIcon className="text-description-muted h-3.5 w-3.5" />
        </HeaderButtonWithToolTip>
      )}

      <HeaderButtonWithToolTip
        testId={`delete-button-${index}`}
        text="Delete"
        tabIndex={-1}
        onClick={onDelete}
      >
        <TrashIcon className="text-description-muted h-3.5 w-3.5" />
      </HeaderButtonWithToolTip>

      <CopyIconButton
        tabIndex={-1}
        text={copyText}
        clipboardIconClassName="h-3.5 w-3.5 text-description-muted"
        checkIconClassName="h-3.5 w-3.5 text-success"
      />

      <FeedbackButtons item={item} />
    </div>
  );
}
