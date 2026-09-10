/**
 * 方案.md §十二: the two history coordinate systems, and the single shift
 * between them.
 *
 * - `absoluteHistoryIndex` — position in the **full on-disk history**. This is
 *   what Core speaks: `history/loadPage` offsets, `conversation/compact`, and
 *   `pagination.loadedOffset` are all absolute.
 * - `windowHistoryIndex` — position inside the **loaded window**
 *   (`session.history`). This is what rendered items and click handlers use.
 *
 * `pagination.loadedOffset` is the number of unloaded items *above* the window,
 * so the two systems differ by that one shift:
 *
 *   absolute = window + loadedOffset
 *   window   = absolute - loadedOffset
 *
 * These helpers take the offset as a plain number instead of a whole session on
 * purpose. Two of the three call sites must use a **captured** offset rather than
 * the current one:
 *
 * - `sessionSubmit` converts before `loadFullHistory` resets the offset to 0;
 * - `compactConversation` converts with the render-time offset that matches the
 *   index the user actually clicked.
 *
 * A `session` parameter would invite passing the current runtime there, which is
 * precisely the wrong value. A number makes the capture explicit at each call
 * site, and keeps the helpers pure.
 *
 * Neither helper validates its result. Deciding what an out-of-window index means
 * (reject, or fall back to a full load) is the caller's business — see
 * `sessionView.useSessionSyntheticSummary`, which range-checks the window index
 * before indexing.
 */

/** Window index → absolute on-disk index. */
export function windowToAbsoluteIndex(
  loadedOffset: number,
  windowHistoryIndex: number,
): number {
  return windowHistoryIndex + loadedOffset;
}

/**
 * Absolute on-disk index → window index. The result can be negative or beyond
 * the window: an absolute index is not necessarily loaded.
 */
export function absoluteToWindowIndex(
  loadedOffset: number,
  absoluteHistoryIndex: number,
): number {
  return absoluteHistoryIndex - loadedOffset;
}
