import { ChatHistoryItem } from "core";
import { v4 as uuidv4 } from "uuid";
import { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";

/**
 * Disk history may predate persisted message ids (legacy sessions). Assign a
 * stable-in-this-process id to any item missing one, keeping existing ids
 * untouched so editor state / compaction loading / applied rules survive.
 *
 * 方案.md §九.13: Core is the long-term authority for legacy id stabilization
 * (`history/migrateIds`); this helper is the GUI-side fallback and must be used
 * by every load path. **It is a fallback, not the mechanism**: an id minted here
 * is stable only for this process, so it must never be treated as proof that the
 * disk identity was migrated.
 *
 * P4b-2: the report variant exists so each load path can say *whether* it had to
 * fall back, without turning that fact into an error or extra Redux state.
 */

export type EnsureMessageIdsReport = {
  items: ChatHistoryItemWithMessageId[];
  /** How many items had to be given a runtime id. 0 means "nothing to do". */
  mintedCount: number;
};

function readId(item: ChatHistoryItem): string | undefined {
  return (item.message as { id?: string }).id;
}

function countMissingIds(items: ChatHistoryItem[]): number {
  let count = 0;
  for (const item of items) {
    if (!readId(item)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Same contract as `ensureMessageIds`, plus the number of minted ids.
 *
 * When nothing is missing the **input array reference is returned unchanged**:
 * `history` identity is meaningful elsewhere (a `[history]` dependency, the
 * persistence snapshot), so a load that changes nothing must not produce a new
 * array. When something is missing only the affected items are copied — items
 * that already had an id keep their reference.
 */
export function ensureMessageIdsWithReport(
  items: ChatHistoryItem[],
): EnsureMessageIdsReport {
  const mintedCount = countMissingIds(items);
  if (mintedCount === 0) {
    return {
      items: items as ChatHistoryItemWithMessageId[],
      mintedCount: 0,
    };
  }
  return {
    items: items.map((item) => {
      if (readId(item)) {
        return item as ChatHistoryItemWithMessageId;
      }
      return {
        ...item,
        message: { ...item.message, id: uuidv4() },
      } as ChatHistoryItemWithMessageId;
    }),
    mintedCount,
  };
}

export function ensureMessageIds(
  items: ChatHistoryItem[],
): ChatHistoryItemWithMessageId[] {
  return ensureMessageIdsWithReport(items).items;
}
