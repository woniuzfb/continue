/**
 * Tags that indicate genuinely rich content — formatting that plain-text
 * pasting would destroy. Deliberately excludes <span>/<div>/<p>/<br>:
 * VS Code and terminals wrap plain code in styled <span>/<div> elements, and
 * those must keep taking the newline-preserving plain-text path (the original
 * empty-line fix). Only when real formatting elements are present (links,
 * bold, lists, tables, headings, images, quotes, code blocks) do we hand the
 * paste back to ProseMirror's default HTML handling.
 */
const RICH_HTML_RE =
  /<(?:a|b|strong|i|em|u|s|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|img|blockquote|code|pre)(?:\s|>)/i;

export function hasRichHtml(html: string): boolean {
  return RICH_HTML_RE.test(html);
}

/**
 * Decide whether the editor should take over the paste with the
 * newline-preserving plain-text path (parseClipboardText).
 *
 * We intercept ONLY when the clipboard has no genuinely rich HTML:
 *
 *  - Image files            -> false (let the Image extension handle them)
 *  - Rich HTML (links etc.) -> false (default ProseMirror HTML handling keeps
 *    formatting, so pasting from a browser/Word no longer flattens to text)
 *  - Plain text or code HTML (spans/divs only, e.g. VS Code / terminals)
 *    with a text/plain payload -> true (ProseMirror's default fallback would
 *    collapse consecutive newlines — the bug this path fixes)
 *  - Nothing usable        -> false (let the default handle it)
 */
export function shouldUsePlainTextPaste(
  cd: Pick<DataTransfer, "items" | "getData">,
): boolean {
  const items = Array.from(cd.items || []);
  if (items.some((i) => i.kind === "file" && i.type.startsWith("image/"))) {
    return false;
  }
  const html = cd.getData("text/html");
  if (html && hasRichHtml(html)) {
    return false;
  }
  const text = cd.getData("text/plain");
  return !!text;
}
