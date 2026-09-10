/**
 * 方案.md §十.1: the single shared first-turn extractor.
 *
 * This used to exist twice — as `HistoryManager.firstTurnItemsOf` in Core and as
 * `firstTurnItemsOf` in the GUI slice — with identical bodies and no shared
 * test. Both are gone; Core's `history/loadPage`, `history/save` and the GUI's
 * request-history builder all call this.
 *
 * Contract: the first turn runs from the first `user` item up to (not
 * including) the second `user` item. No user message means no first turn, and
 * the input array is never mutated. Deliberately does nothing else — no merging,
 * no compaction, no `constructMessages()`, no thinking removal, no tool-result
 * rebuilding (方案.md §十.1) — because the Local Provider derives its
 * conversation key from these exact items.
 */
export function extractFirstTurnItems<T extends { message: { role: string } }>(
  history: readonly T[],
): T[] {
  const firstUserIndex = history.findIndex(
    (item) => item.message.role === "user",
  );
  if (firstUserIndex < 0) {
    return [];
  }

  let end = history.length;
  for (let i = firstUserIndex + 1; i < history.length; i++) {
    if (history[i].message.role === "user") {
      end = i;
      break;
    }
  }

  return history.slice(firstUserIndex, end);
}
