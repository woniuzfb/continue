import { ChatHistoryItem } from "core";

import { useDeleteCompaction } from "../../util/compactConversation";
import { AnimatedEllipsis } from "../AnimatedEllipsis";
import { useSessionCompactionLoading } from "../../redux/selectors/sessionView";
import { SummaryCard } from "./SummaryCard";

interface ConversationSummaryProps {
  item: ChatHistoryItem;
  index: number;
}

export default function ConversationSummary(props: ConversationSummaryProps) {
  const messageId = (props.item.message as { id?: string }).id;
  const isLoading = useSessionCompactionLoading(messageId);
  const deleteCompaction = useDeleteCompaction();

  if (!props.item.conversationSummary && !isLoading) {
    return null;
  }

  // Loading state - much simpler
  if (isLoading) {
    return (
      <div className="mx-1.5 mb-4 mt-2">
        <div className="bg-vsc-input-background rounded-md shadow-sm">
          <div className="text-description flex items-center justify-start px-3 py-2 text-xs">
            <span>Generating conversation summary</span>
            <AnimatedEllipsis />
          </div>
        </div>
      </div>
    );
  }

  return (
    <SummaryCard
      content={props.item.conversationSummary ?? ""}
      itemIndex={props.index}
      // Identity, not the window index (方案.md §十二): the item holding the
      // summary is addressed by its own id, and `index` stays for `itemIndex`.
      // A missing id is not an identity — never send an empty string in its place.
      onDelete={() => {
        if (messageId) {
          void deleteCompaction(messageId);
        }
      }}
    />
  );
}
