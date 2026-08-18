import {
  ChatMessage,
  ContextItem,
  MessageContent,
  MessagePart,
  TextMessagePart,
} from "../index";

export function stripImages(messageContent: MessageContent): string {
  if (typeof messageContent === "string") {
    return messageContent;
  }

  return messageContent
    .filter((part) => part.type === "text")
    .map((part) => (part as TextMessagePart).text)
    .join("\n");
}

export function renderChatMessage(message: ChatMessage): string {
  switch (message?.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "system":
      return stripImages(message.content);
    case "tool":
      return message.content;
    default:
      return "";
  }
}

export function renderContextItems(contextItems: ContextItem[]): string {
  return contextItems.map((item) => item.content).join("\n\n");
}

export function renderContextItemsWithStatus(contextItems: any[]): string {
  return contextItems
    .map((item) => {
      let result = item.content;

      // If this item has a status, append it directly after the content
      if (item.status) {
        result += `\n[Status: ${item.status}]`;
      }

      return result;
    })
    .join("\n\n");
}

export function normalizeToMessageParts(message: ChatMessage): MessagePart[] {
  switch (message.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "system":
      return Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: message.content }];
    case "tool":
      return [{ type: "text", text: message.content }];
  }
}

/**
 * Match a <file_content ...>...</file_content> block where BOTH the opening
 * and the closing tag must each occupy their own line (line-anchored via `^`
 * + `m` flag). This mirrors the Python server-side parser
 * (`_CLINE_FILE_CONTENT_RE` in voice_edge.py): marker-like text embedded
 * mid-line in ordinary prose (a user quoting/discussing `<file_content ...>`)
 * never starts a span, and is never mistaken for a real attachment block.
 *
 * Groups:
 *   - attrs:    the attribute string between `<file_content` and `>`. Limited
 *               to `[^>\r\n]*` so the opening tag can never span lines,
 *               matching the server's `[^>\r\n]*`.
 *   - content:  the inner payload (non-greedy, across newlines), beginning
 *               AFTER the opening line's newline so the payload is byte-exact.
 * The opening tag must be followed by optional trailing spaces/tabs and a line
 * ending. The closing `</file_content\s*>` must likewise start at the
 * beginning of a line (modulo leading whitespace) and be followed by a line
 * ending or EOF, consuming an optional single trailing newline so consecutive
 * blocks joined by `\n` don't leave stray blank lines.
 */
const FILE_CONTENT_BLOCK_RE =
  /^[ \t]*<file_content\b([^>\r\n]*)>[ \t]*\r?\n([\s\S]*?)^[ \t]*<\/file_content\s*>[ \t]*(?:\r?\n|$)/gim;

/**
 * Match the SELF-CLOSING form `<file_content path="..."/>`. This is the
 * persistence-slimming format written by stripAttachedFileContent (history.ts):
 * attachment bodies are stripped before hitting disk, leaving only the marker.
 * Line-anchored like FILE_CONTENT_BLOCK_RE so a mid-line mention in prose is
 * never mistaken for a real slimmed attachment.
 */
const FILE_CONTENT_SELF_CLOSING_RE =
  /^[ \t]*<file_content\b([^>\r\n]*)\/>[ \t]*(?:\r?\n|$)/gim;

/**
 * Extract the path attribute value from an opening tag's attribute string.
 * Supports double-quoted, single-quoted, and bare (unquoted) values, matching
 * the Python `_CLINE_FILE_PATH_RE`.
 */
function extractPathFromAttrs(attrs: string): string | undefined {
  const m = attrs.match(/\bpath\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  if (!m) return undefined;
  const raw = m[1] ?? m[2] ?? m[3] ?? "";
  return raw.trim().replace(/\\+$/, "");
}

/**
 * Replace line-delimited <file_content path="...">...</file_content> blocks
 * with a `[file: path]` placeholder, keeping history context lightweight while
 * still indicating that a file was attached. The base64 payload of inline
 * markdown images (`![alt](data:image/...;base64,...)`) is also stripped,
 * leaving only the `![alt]` marker.
 *
 * Line-anchored matching avoids false positives when file content contains
 * the literal string `<file_content` mid-line; only tags that start at the
 * beginning of a line (modulo leading whitespace) are recognized.
 */
export function replaceFileContentBlocks(text: string): string {
  if (!text) return text;
  // Self-closing markers FIRST. The full-block regex's attrs group
  // `[^>\r\n]*` can absorb the `/` of a self-closing tag, making it match
  // from a self-closing marker all the way to a LATER block's closing tag —
  // swallowing that block whole. Replacing self-closing forms first removes
  // them from the text so the full-block pass can only match real pairs.
  return text
    .replace(FILE_CONTENT_SELF_CLOSING_RE, (_match, attrs: string) => {
      const path = extractPathFromAttrs(attrs);
      return path ? `[file: ${path}]` : "[file]";
    })
    .replace(FILE_CONTENT_BLOCK_RE, (_match, attrs: string) => {
      const path = extractPathFromAttrs(attrs);
      return path ? `[file: ${path}]` : "[file]";
    });
}

/**
 * Collapse line-delimited <file_content path="...">...</file_content> blocks
 * into their self-closing form `<file_content path="..."/>`, dropping the
 * body. Used to slim promptLogs before persistence: a promptLog records the
 * FINAL rendered prompt at the LLM boundary, where the current message's
 * attachments appear as full blocks (one full copy per tool-loop round).
 * Idempotent: collapsed markers never re-match the full-block regex.
 */
export function collapseFileContentBlocks(text: string): string {
  if (!text) return text;
  return text.replace(FILE_CONTENT_BLOCK_RE, (_match, attrs: string) => {
    const path = extractPathFromAttrs(attrs);
    return path ? `<file_content path="${path}"/>` : "<file_content/>";
  });
}

/**
 * Strip the base64 payload from inline markdown images like
 * `![alt](data:image/png;base64,...)`, keeping only the `![alt]` marker.
 * Uses paren-depth tracking so base64 content containing ")" is handled.
 */
export function stripInlineImageBase64(text: string): string {
  if (!text) return text;
  let result = "";
  let i = 0;
  const IMG_OPEN = "![";

  while (i < text.length) {
    const openStart = text.indexOf(IMG_OPEN, i);
    if (openStart === -1) {
      result += text.slice(i);
      break;
    }

    const altEnd = text.indexOf("]", openStart + IMG_OPEN.length);
    if (altEnd === -1) {
      result += text.slice(i);
      break;
    }

    if (text[altEnd + 1] !== "(") {
      result += text.slice(i, openStart + IMG_OPEN.length);
      i = openStart + IMG_OPEN.length;
      continue;
    }

    const urlStart = altEnd + 2;
    const looksLikeDataUrl = text.slice(urlStart, urlStart + 5) === "data:";

    if (!looksLikeDataUrl) {
      result += text.slice(i, openStart + IMG_OPEN.length);
      i = openStart + IMG_OPEN.length;
      continue;
    }

    let depth = 1;
    let pos = urlStart;
    while (pos < text.length && depth > 0) {
      const ch = text[pos];
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      pos++;
    }

    if (depth !== 0) {
      result += text.slice(i);
      break;
    }

    // Preserve any text BETWEEN the previous cursor and this image marker.
    // Without this, everything the user typed before an inline data-image was
    // silently dropped — corrupting the real prompt in constructMessages (not
    // just the token estimate), because history user messages are rewritten
    // through this function before being sent to the model.
    result += text.slice(i, openStart);
    const altText = text.slice(openStart + IMG_OPEN.length, altEnd);
    result += `![${altText}]`;
    i = pos + 1;
  }

  return result;
}
