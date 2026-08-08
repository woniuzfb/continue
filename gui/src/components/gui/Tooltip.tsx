import { cloneElement, CSSProperties, ReactElement, useId } from "react";
import ReactDOM from "react-dom";
import { ITooltip, Tooltip } from "react-tooltip";
import { vscBackground, vscForeground } from "..";
import { varWithFallback } from "../../styles/theme";
import { fontSize } from "../../util";

// Needed to override styles in react-tooltip
const TooltipStyles: CSSProperties = {
  fontSize: fontSize(-4),
  backgroundColor: vscBackground,
  outline: `0.5px solid ${varWithFallback("description")}`,
  color: vscForeground,
  padding: "4px 8px",
  zIndex: 1000,
  maxWidth: "80vw",
  textAlign: "center",
  // react-tooltip 默认 width: max-content：超长无空格内容（如下载链接）会把
  // tooltip 撑到 80vw 宽且文本无法换行，溢出视口产生横向滚动条，
  // 导致聊天区在悬停时抖动。强制断行把内容限制在 maxWidth 内。
  wordBreak: "break-all",
  overflowWrap: "anywhere",
};

export function ToolTip({
  children,
  content,
  ...props
}: Omit<ITooltip, "id" | "children" | "content"> & {
  content: ITooltip["children"];
  children: ReactElement;
}) {
  const tooltipId = useId();

  const combinedStyles = {
    ...TooltipStyles,
    ...props.style,
  };

  const tooltipPortalDiv = document.getElementById("tooltip-portal-div");

  const childrenWithTooltipId = cloneElement(children, {
    "data-tooltip-id": tooltipId,
  });

  return (
    <>
      {childrenWithTooltipId}
      {tooltipPortalDiv &&
        ReactDOM.createPortal(
          <Tooltip
            {...props}
            id={tooltipId}
            noArrow
            style={combinedStyles}
            opacity={1}
            delayShow={200}
          >
            {content}
          </Tooltip>,
          tooltipPortalDiv,
        )}
    </>
  );
}
