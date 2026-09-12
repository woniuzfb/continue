import { findLastIndex } from "core/util/findLast";
import type { SessionRuntimeState } from "../slices/sessionsSlice";

/**
 * 方案.md §九.5 / §九.6 / §九.7: send-time trim planning.
 *
 * This module is pure: it decides *whether* a trim is safe and returns the
 * exact disk accounting for it. `trimSessionHistoryWindow` remains the only
 * writer of the window, so every invariant lives in one reducer.
 *
 * POST-SAVE CONTRACT: this must only be called after a successful
 * `history/save` whose response is still the current revision. That contract is
 * what makes the accounting sound: Core writes the window verbatim
 * (`finalHistory = [...existingHistory.slice(0, headCount), ...session.history]`,
 * `core/util/history.ts:501`) and a non-truncated save writes the GUI array
 * itself, so after a successful save the disk tail IS the GUI window — 1:1, no
 * matter how the window was merged for display before the save.
 *
 * 方案.md §九.6 warns that `history.length` must not be assumed equal to
 * `loadedDiskCount`. That is exactly why `loadedDiskCount` is deliberately NOT
 * consulted here: it counts *raw page items before bubble merge*
 * (`prependSessionHistory`) and is therefore a PRE-save value. Once a save has
 * rewritten the tail it is stale, and using it would permanently veto the trim
 * for every merged window (方案.md §十九.5 的逃生口靠保存响应判定，不靠该计数).
 * The authoritative check is the save response's own total.
 */

export type HistoryTrimPlan = {
  /** GUI items retained at the tail of the window. */
  keepCount: number;
  removedGuiItems: number;
  removedDiskItems: number;
  retainedDiskItemCount: number;
  fullDiskItemCount: number;
};

export function getLazyLoadTrimLimit(initialCount: number | undefined): number {
  return Math.max(1, Math.floor(initialCount ?? 4));
}

/**
 * @param fullDiskItemCount `totalHistoryCount` from the authoritative
 *   `history/save` response. `undefined` means the host did not report it, so
 *   the mapping cannot be trusted and no trim is planned.
 * @param visibleFloor 方案.md §7.2.8: how many trailing window rows the viewport
 *   is currently showing (`0` for a session that is not on screen). The trim
 *   exists to release memory, and it may only release rows the user cannot see:
 *   trimming into the visible area collapses the transcript under the reader at
 *   the exact moment the reply finishes (a 12-row window dropped to 4 rows
 *   right after the terminal save).
 * @param scrollBuffer 方案.md §7.2.8: rows kept **above** the visible ones so the
 *   transcript still overflows after the trim. Keeping exactly the visible rows
 *   leaves `scrollHeight === clientHeight`, which is the precise condition
 *   `useAutoScroll`'s fill-viewport pagination exists to detect: it prepends a
 *   page straight away, the content grows back, and the user sees the scrollbar
 *   jump up and return (real trace: `history-trim items=12 keepItems=5
 *   floorItems=5`, then "the scrollbar suddenly grew, then went back"). The
 *   buffer also absorbs a measurement that is up to one scroll behind.
 */
export function planHistoryTrim(
  session: SessionRuntimeState,
  limit: number,
  fullDiskItemCount: number | undefined,
  visibleFloor = 0,
  scrollBuffer = 0,
): HistoryTrimPlan | null {
  const length = session.history.length;
  const safeLimit = getLazyLoadTrimLimit(limit);
  if (length <= safeLimit) {
    return null;
  }

  if (fullDiskItemCount === undefined) {
    return null;
  }
  // The authoritative mapping proof: Core kept exactly `loadedOffset` frozen
  // head items and appended exactly `length` window items, so the disk now
  // holds `loadedOffset + length`. Anything else — Core thinning the disk, a
  // stale response, a window that is not contiguous with the head — means the
  // mapping is unreliable and the trim must not guess
  // (方案.md §九.6「无法可靠映射时不执行 trim」).
  const loadedOffset = session.pagination.loadedOffset ?? 0;
  if (fullDiskItemCount !== loadedOffset + length) {
    return null;
  }

  // 方案.md §九.5: never split the current turn — a turn can be longer than
  // `limit` (thinking + tool bubbles) and dropping its user message would break
  // delta compile, the streaming placeholder and `getCurrentTurnItems`.
  const latestUserIndex = findLastIndex(
    session.history,
    (item) => item.message.role === "user",
  );
  const currentTurnLength = latestUserIndex >= 0 ? length - latestUserIndex : 0;
  const keepCount = Math.max(
    safeLimit,
    currentTurnLength,
    Math.max(0, Math.floor(visibleFloor)) +
      Math.max(0, Math.floor(scrollBuffer)),
  );
  if (keepCount >= length) {
    return null;
  }

  const removedGuiItems = length - keepCount;
  return {
    keepCount,
    removedGuiItems,
    // 1:1 here by the proof above, so every dropped GUI item is a dropped disk
    // item and the retained window is exactly `keepCount` disk items.
    removedDiskItems: removedGuiItems,
    retainedDiskItemCount: keepCount,
    fullDiskItemCount,
  };
}
