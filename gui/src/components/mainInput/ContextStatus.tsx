import { useMemo, useRef } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { saveCurrentSession } from "../../redux/thunks/session";
import { useCompactConversation } from "../../util/compactConversation";
import { ToolTip } from "../gui/Tooltip";

// 将 token 数格式化为紧凑形式：1234 -> 1.2K, 128000 -> 128K
function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return String(tokens);
}

const ContextStatus = () => {
  const dispatch = useAppDispatch();
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const selectedChatModel = useAppSelector(
    (state) => state.config.config.selectedModelByRole.chat?.model,
  );
  const previousHistoryLength = useRef<number | null>(null);
  const previousSelectedChatModel = useRef<string | null>(null);
  const history = useAppSelector((state) => state.session.history);
  const percent = Math.round((contextPercentage ?? 0) * 100);
  const isPruned = useAppSelector((state) => state.session.isPruned);
  const contextInputTokens = useAppSelector(
    (state) => state.session.contextInputTokens,
  );
  const contextLength = useAppSelector((state) => state.session.contextLength);

  const isDifferentModelAndSameHistory = useMemo(() => {
    if (!selectedChatModel) return false;
    // only reset if history changes
    if (previousHistoryLength.current !== history.length) {
      previousHistoryLength.current = history.length;
      previousSelectedChatModel.current = selectedChatModel;
      return false;
    }
    return previousSelectedChatModel.current !== selectedChatModel;
  }, [history.length, selectedChatModel]);

  const compactConversation = useCompactConversation();

  // if user changed to a different model, we shouldn't show the context status until the user sends a new message
  if (isDifferentModelAndSameHistory) {
    return null;
  }

  // 颜色随百分比分段：< 60% 灰；60-80% 黄；>= 80% 或已裁剪 红
  let ringColorClass = "text-description";
  if (isPruned || percent >= 80) {
    ringColorClass = "text-error";
  } else if (percent >= 60) {
    ringColorClass = "text-warning";
  }

  // 进度环几何参数
  const ringSize = 14;
  const ringStroke = 2;
  const ringRadius = (ringSize - ringStroke) / 2; // 6
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringDashOffset = ringCircumference * (1 - percent / 100);

  return (
    <div>
      <ToolTip
        closeEvents={{
          // blur: false,
          mouseleave: true,
          click: true,
          mouseup: false,
        }}
        clickable
        content={
          <div className="flex flex-col gap-0 text-left text-xs">
            <span className="inline-block">
              {`${percent}% of context filled.`}
            </span>
            {contextInputTokens !== undefined &&
              contextLength !== undefined && (
                <span className="text-description inline-block">
                  {`${formatTokens(contextInputTokens)} / ${formatTokens(
                    contextLength,
                  )} tokens`}
                </span>
              )}
            {isPruned && (
              <span className="inline-block">
                {`Oldest messages are being removed.`}
              </span>
            )}
            {history.length > 0 && (
              <div className="flex flex-col gap-1 whitespace-pre">
                <div>
                  <span
                    className="hover:text-link inline-block cursor-pointer underline"
                    onClick={() => compactConversation(history.length - 1)}
                  >
                    Compact conversation
                  </span>
                  {"\n"}
                  <span
                    className="hover:text-link inline-block cursor-pointer underline"
                    onClick={() => {
                      void dispatch(
                        saveCurrentSession({
                          openNewSession: true,
                        }),
                      );
                    }}
                  >
                    Start a new session
                  </span>
                </div>
              </div>
            )}
          </div>
        }
      >
        <svg
          width={ringSize}
          height={ringSize}
          viewBox={`0 0 ${ringSize} ${ringSize}`}
          className={ringColorClass}
          data-testid="context-status-ring"
        >
          {/* 背景圆环 */}
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={ringRadius}
            fill="none"
            stroke="currentColor"
            strokeWidth={ringStroke}
            opacity={0.2}
          />
          {/* 进度圆环（从顶部顺时针填充） */}
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={ringRadius}
            fill="none"
            stroke="currentColor"
            strokeWidth={ringStroke}
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            strokeDashoffset={ringDashOffset}
            style={{
              transform: "rotate(-90deg)",
              transformOrigin: "center",
              transition: "stroke-dashoffset 0.3s ease-in-out",
            }}
          />
        </svg>
      </ToolTip>
    </div>
  );
};

export default ContextStatus;
