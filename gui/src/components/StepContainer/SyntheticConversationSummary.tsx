import { useDeleteCompaction } from "../../util/compactConversation";
import { useSessionSyntheticSummary } from "../../redux/selectors/sessionView";
import { SummaryCard } from "./SummaryCard";

/**
 * 方案.md §十一: when the compact carrier has been trimmed out of the loaded
 * window, the compaction boundary is rendered synthetically at the head of the
 * window so the user still sees where the previous conversation was compacted.
 *
 * `useSessionSyntheticSummary` returns the summary only while the carrier is
 * absent, so a real carrier and this separator never render at the same time
 * (no double divider). Prepending history until the carrier is back in the
 * window removes it automatically.
 */
export function SyntheticConversationSummary() {
  const summary = useSessionSyntheticSummary();
  const deleteCompaction = useDeleteCompaction();

  if (!summary) {
    return null;
  }

  return (
    <div data-testid="synthetic-summary-separator">
      <div className="mx-1.5 my-5">
        <div className="flex items-center">
          <div className="border-border flex-1 border-t border-solid"></div>
          <span className="text-description mx-3 text-xs">
            Previous Conversation Compacted
          </span>
          <div className="border-border flex-1 border-t border-solid"></div>
        </div>
      </div>
      <SummaryCard
        content={summary.content}
        itemIndex={0}
        onDelete={() => {
          // Identity, never the index: `sourceAbsoluteIndex` can be stale after
          // an edit or a merge, and the hook hydrates the window before looking
          // the id up (方案.md §十二).
          void deleteCompaction(summary.sourceMessageId);
        }}
      />
    </div>
  );
}
