/**
 * Scrolls one transcript row to the top **of the transcript itself**.
 *
 * Deliberately not `scrollIntoView`: that scrolls *every* scrollable ancestor,
 * and this app's shell is scrollable. `LayoutTopDiv` declares `overflow-x: auto`,
 * which computes `overflow-y` to `auto` (CSS: a `visible` axis next to a
 * non-visible one becomes `auto`), and `body` does the same with
 * `overflow-x: hidden`. So "jump to previous/next message" also scrolled the
 * shell by a few pixels and pushed the session tab bar past the top of the
 * viewport — reported as "the tab's top edge gets cut off when I click Go to
 * previous message".
 *
 * Anchoring on the row's rect (not `offsetTop`) keeps this correct for rows
 * nested inside wrappers, and the container's own `scrollTop` is the base, so
 * the call is idempotent.
 */
export function scrollTranscriptToMessage(
  container: HTMLElement | null,
  messageId: string,
): boolean {
  if (!container) {
    return false;
  }
  const target = container.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"]`,
  );
  if (!target) {
    return false;
  }
  const delta =
    target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
  return true;
}
