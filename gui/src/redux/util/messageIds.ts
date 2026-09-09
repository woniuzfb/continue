import { ChatHistoryItem } from "core";
import { v4 as uuidv4 } from "uuid";
import { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";

/**
 * Disk history may predate persisted message ids (legacy sessions). Assign a
 * stable-in-this-process id to any item missing one, keeping existing ids
 * untouched so editor state / compaction loading / applied rules survive.
 *
 * 方案.md §九.13: Core is the long-term authority for legacy id stabilization;
 * this helper is the GUI-side stopgap and must be used by every load path.
 */
export function ensureMessageIds(
  items: ChatHistoryItem[],
): ChatHistoryItemWithMessageId[] {
  return items.map((item) => {
    if ((item.message as { id?: string }).id) {
      return item as ChatHistoryItemWithMessageId;
    }
    return {
      ...item,
      message: { ...item.message, id: uuidv4() },
    };
  });
}
