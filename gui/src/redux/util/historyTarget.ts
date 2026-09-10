import { ChatHistoryItem } from "core";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";

/**
 * 方案.md §十二 / LazyLoad_merge_provenance_设计.md §4: locate one semantic target
 * in two arrays that do **not** share a coordinate system.
 *
 * `session.history` after a full hydration is not the disk array: it keeps the
 * merged window (`prependSessionHistory → mergeSplitReplies`) and only prepends the
 * frozen head. So the same target has a different index in each array, and — more
 * importantly — the two arrays need **different predicates** to find it.
 */
export type HistoryTargetOnDisk = {
  /** Index into the raw `history/load` response (the disk order). */
  diskIndex: number;
  /** Index into the hydrated `session.history` (the window order). */
  guiIndex: number;
};

/**
 * Raw disk lookup: an exact persisted `message.id` match, nothing else.
 *
 * The array is the `history/load` response, so legacy items may have no id at all
 * (方案.md §九.13 owns the real stabilization); an item without an id simply never
 * matches. A uuid minted by `ensureMessageIds` for _this_ response is not a
 * cross-response identity and must not be invented here.
 */
export function findDiskIndexByMessageId(
  rawDiskHistory: ChatHistoryItem[],
  targetMessageId: string,
): number {
  return rawDiskHistory.findIndex(
    (item) => (item.message as { id?: string }).id === targetMessageId,
  );
}

/**
 * GUI lookup: the item's own id **or** membership in its merge provenance.
 *
 * A merged bubble's own id is its group's first assistant (`mergeSplitReplies`
 * spreads `firstAssistant`), so the carrier of a bubble — the last raw member in
 * disk order — is not any GUI item's `message.id`; it only exists inside
 * `mergedReplyProvenance.sourceMessageIds`. Looking the target up by id alone
 * therefore fails for every pre-save merged bubble, which is why this predicate
 * must be the wider one.
 */
export function findGuiIndexContainingMessageId(
  guiHistory: ChatHistoryItemWithMessageId[],
  targetMessageId: string,
): number {
  return guiHistory.findIndex(
    (item) =>
      item.message.id === targetMessageId ||
      item.mergedReplyProvenance?.sourceMessageIds.includes(targetMessageId) ===
        true,
  );
}

/**
 * Resolve a target in both coordinate systems at once.
 *
 * Returns `undefined` when either side misses: the caller then **aborts
 * explicitly** — it must not fall back to an arithmetic index, must not append,
 * and must not operate on some other message. Both indices are only meaningful
 * together (one says where to write on disk, the other where to read in the
 * window).
 */
export function resolveHistoryTargetOnDisk({
  rawDiskHistory,
  guiHistory,
  targetMessageId,
}: {
  rawDiskHistory: ChatHistoryItem[];
  guiHistory: ChatHistoryItemWithMessageId[];
  targetMessageId: string;
}): HistoryTargetOnDisk | undefined {
  const diskIndex = findDiskIndexByMessageId(rawDiskHistory, targetMessageId);
  if (diskIndex < 0) {
    return undefined;
  }
  const guiIndex = findGuiIndexContainingMessageId(guiHistory, targetMessageId);
  if (guiIndex < 0) {
    return undefined;
  }
  return { diskIndex, guiIndex };
}
