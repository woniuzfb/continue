/**
 * Decide whether the editor should take over the paste with the
 * newline-preserving plain-text path (parseClipboardText).
 *
 * The chat editor's schema has NO formatting nodes (no bold / heading /
 * list / table / horizontal-rule), so pasted rendered HTML would be
 * flattened to plain text anyway — while the markdown source in
 * text/plain (the faithful representation the user actually copied)
 * would be lost, and blank lines rendered as `<div>`/`<br>` collapse.
 *
 * Therefore we ALWAYS intercept when a text/plain payload exists:
 *
 *  - Image files            -> false (let the Image extension handle them)
 *  - text/plain present     -> true (preserves markdown symbols, blank
 *    lines and code exactly as copied)
 *  - Nothing usable         -> false (let the default handle it)
 */
export function shouldUsePlainTextPaste(
  cd: Pick<DataTransfer, "items" | "getData">,
): boolean {
  const items = Array.from(cd.items || []);
  if (items.some((i) => i.kind === "file" && i.type.startsWith("image/"))) {
    return false;
  }
  const text = cd.getData("text/plain");
  return !!text;
}
