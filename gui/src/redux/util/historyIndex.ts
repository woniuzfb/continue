/**
 * 方案.md §十二: the history coordinate systems, and the single shift between
 * the two that the helpers below convert.
 *
 * `absoluteHistoryIndex` is a zero-based position from the start of the full
 * history. `conversation/compact.index` uses this coordinate.
 *
 * `windowHistoryIndex` is a zero-based position inside the currently loaded
 * `session.history` window.
 *
 * `pagination.loadedOffset` is the number of full-history items before the
 * window and therefore acts as the window's absolute start coordinate.
 *
 * `history/loadPage.offset` is different: it counts items skipped from the
 * history tail and is not an absolute history index.
 *
 * MAPPING PRECONDITION — these helpers perform only the coordinate shift. They
 * are valid only when the caller knows that each item in the relevant window
 * maps 1:1 to an item in the full history.
 *
 * They do not prove that mapping. In particular, a GUI history window that has
 * been bubble-merged may not be index-compatible with raw disk history:
 * `sessionsSlice.prependSessionHistory` merges when
 * `dontMergeHistoricalReplyBubbles` is false, so one GUI item can stand for
 * several disk items. Callers must establish the mapping, or fully hydrate to a
 * reliably addressable history, before using the converted index for an
 * index-based disk operation. When the mapping cannot be established, prefer
 * message identity — `messageId` is the first choice for mutations
 * (方案.md §十二).
 *
 * The helpers take `loadedOffset` rather than a session on purpose. Two of the
 * call sites must use a **captured** offset rather than the current one:
 *
 * - `sessionSubmit` converts with the offset captured **before** the editor
 *   content is resolved: the commit must address the window the caller saw, and
 *   since 方案.md §7.2.6 submitting no longer hydrates that window at all, the
 *   offset can legitimately differ by the time the commit runs;
 * - `compactConversation` pairs the offset captured by the same hook callback
 *   that receives the window-relative index, and does not re-read `pagination`
 *   after full hydration.
 *
 * A `session` parameter would invite passing the current runtime, which is the
 * wrong value in exactly those places.
 *
 * Neither helper validates its result: deciding whether an out-of-window index
 * means "reject" or "fall back to a full load" belongs to the caller — see
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
