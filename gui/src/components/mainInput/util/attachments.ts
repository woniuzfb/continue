import { MessageContent, MessagePart, TextMessagePart } from "core";

import { AttachmentMeta, AttachedFile } from "../types";

/**
 * Rebuilds {@link AttachedFile}s for a message that was already sent. When a
 * send fails mid-stream, the user message stays in history with the file
 * paths in `message.metadata.attachments` and the file contents embedded in
 * `message.content` as `<file_content path="...">` text blocks. Resubmitting
 * that message (edit-and-resend, or the error dialog's "Resubmit last
 * message") must carry those files along; callers of `streamResponseThunk`
 * don't pass `attachments` in those paths, so we rebuild them here before
 * `submitEditorAndInitAtIndex` clears the message content. The same helper is
 * used by `clearDanglingMessages` to restore rolled-back attachments into
 * the input.
 */
export function extractAttachmentsFromMessage(message: {
  content: MessageContent;
  metadata?: { attachments?: AttachmentMeta[] };
}): AttachedFile[] {
  const meta = message.metadata?.attachments ?? [];
  if (meta.length === 0) {
    return [];
  }
  const parts: MessagePart[] = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: message.content }];
  const text = parts
    .filter((p): p is TextMessagePart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const contents = new Map<string, string>();
  const foundPaths = new Set<string>();
  const fileContentRe =
    /<file_content path="([^"]*)">\n([\s\S]*?)\n<\/file_content>/g;
  for (const match of text.matchAll(fileContentRe)) {
    foundPaths.add(match[1]);
    contents.set(match[1], match[2]);
  }
  // Keep every attachment whose <file_content> block was found (including
  // genuinely empty files); only drop entries whose block could not be
  // extracted (e.g. the message predates the attachment feature).
  return meta
    .map((m) => ({
      name: m.name,
      path: m.path,
      content: contents.get(m.path) ?? "",
    }))
    .filter((f) => foundPaths.has(f.path));
}
