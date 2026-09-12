/**
 * 方案.md §7.3.2: where a suggestion popup (`/` slash commands, `@` mentions) is appended.
 *
 * The container is rendered **per editor**, so its id must be unique per editor and the lookup
 * must go through that id. It used to be one global id with `document.getElementById`, which
 * broke as soon as §九.1/§九.2 started keeping every tab mounted: a document with N tabs holds one
 * such element per editor of every tab, `getElementById` returns the first in document order (the
 * first tab's editor), and a popup opened from any other tab was appended into a `display: none`
 * subtree — the menu simply never appeared, and which tab "worked" followed the tab order.
 *
 * Lives in its own leaf module on purpose: both `TipTapEditor` and `editorConfig` need it, and
 * neither should have to import the other just for a string.
 */
export const TIPPY_DIV_ID = "tippy-js-div";

/** Unique per editor: `sessionId` separates tabs, `inputId` separates editors within one tab. */
export function tippyContainerId(sessionId: string, inputId: string): string {
  return `${TIPPY_DIV_ID}-${sessionId}-${inputId}`;
}
