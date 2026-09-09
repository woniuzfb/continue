import { TrashIcon } from "@heroicons/react/24/outline";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/solid";
import { useState } from "react";
import HeaderButtonWithToolTip from "../gui/HeaderButtonWithToolTip";
import StyledMarkdownPreview from "../StyledMarkdownPreview";

/**
 * 方案.md §十一: the collapsible summary card shared by the real carrier
 * (`ConversationSummary`, rendered at the item's position) and the synthetic
 * separator (rendered at the head of a window whose carrier was trimmed).
 */
export function SummaryCard({
  content,
  itemIndex,
  onDelete,
}: {
  content: string;
  itemIndex: number;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mx-1.5 mb-4 mt-2">
      <div className="bg-vsc-input-background rounded-md shadow-sm">
        <div
          className="text-description flex cursor-pointer items-center gap-2 px-3 py-2 text-xs transition-colors duration-200 hover:brightness-105"
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronUpIcon className="h-3 w-3" />
          ) : (
            <ChevronDownIcon className="h-3 w-3" />
          )}
          <span className="flex-1">Conversation Summary</span>
          <HeaderButtonWithToolTip
            text="Delete summary"
            testId="delete-summary-button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <TrashIcon className="text-description-muted h-3 w-3" />
          </HeaderButtonWithToolTip>
        </div>
        {open && (
          <>
            <div className="border-border border-0 border-t border-solid"></div>
            <div className="max-h-[400px] w-full max-w-full overflow-x-auto px-3 pb-3 pt-2">
              <StyledMarkdownPreview
                isRenderingInStepContainer
                source={content}
                itemIndex={itemIndex}
                useParentBackgroundColor
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
