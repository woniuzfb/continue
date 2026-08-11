import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import {
  InputModifiers,
  MessageContent,
  MessagePart,
  TextMessagePart,
} from "core";

import { v4 as uuidv4 } from "uuid";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { AttachedFile, AttachmentMeta } from "../../components/mainInput/types";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  resetNextCodeBlockToApplyIndex,
  setInactive,
  submitEditorAndInitAtIndex,
  updateHistoryItemAtIndex,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { loadFullHistory } from "./loadFullHistory";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";
import { updateFileSymbolsFromFiles } from "./updateFileSymbols";

/**
 * Builds the text block appended to `message.content` (the payload sent to the
 * LLM) when files are attached. The text is NOT injected into editorState, so
 * it does not show up when the already-sent user message is echoed back; the
 * UI renders file chips from `message.metadata.attachments` instead.
 */
function buildAttachedFilesText(files: AttachedFile[]): string {
  const blocks = files
    .map(
      (f) => `<file_content path="${f.path}">\n${f.content}\n</file_content>`,
    )
    .join("\n\n");
  return `\n\nFiles attached by the user:\n\n${blocks}\n`;
}

/**
 * Rebuilds {@link AttachedFile}s for a message that was already sent. When a
 * send fails mid-stream, the user message stays in history with the file
 * paths in `message.metadata.attachments` and the file contents embedded in
 * `message.content` as `<file_content path="...">` text blocks. Resubmitting
 * that message (edit-and-resend, or the error dialog's "Resubmit last
 * message") must carry those files along; callers of `streamResponseThunk`
 * don't pass `attachments` in those paths, so we rebuild them here before
 * `submitEditorAndInitAtIndex` clears the message content.
 */
function extractAttachmentsFromMessage(message: {
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

export const streamResponseThunk = createAsyncThunk<
  boolean,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
    index?: number;
    attachments?: AttachedFile[];
  },
  ThunkApiType
>(
  "chat/streamResponse",
  async (
    { editorState, modifiers, index, attachments },
    { dispatch, extra, getState },
  ) => {
    // streamThunkWrapper 会吞掉错误并弹错误对话框，因此这里用它的返回值
    // 判断发送是否真正成功：调用方（发送入口）在失败时需要保留用户已选
    // 的文件，避免错误中断后文件被清空。
    const succeeded = await dispatch(
      streamThunkWrapper(async () => {
        // 懒加载状态下，无论新消息还是 retry/edit，都必须先加载完整 history，
        // 否则 LLM 只收到部分上下文。retry/edit 传入的 index 是基于当前
        // （部分）history 的视图，加载完整后需偏移 headCount 到绝对位置。
        const preState = getState();
        let indexOffset = 0;
        if (preState.session.historyTruncated) {
          indexOffset = preState.session.historyLoadedOffset ?? 0;
          try {
            await dispatch(loadFullHistory()).unwrap();
          } catch (e) {
            // 加载完整历史失败：中止发送，避免 LLM 只收到部分上下文
            dispatch(setInactive());
            throw e;
          }
        }

        const state = getState();
        const selectedChatModel = selectSelectedChatModel(state);
        // index 偏移：懒加载 history 中的相对 index → 完整 history 中的绝对 index
        const inputIndex =
          index !== undefined
            ? index + indexOffset
            : state.session.history.length;

        if (!selectedChatModel) {
          throw new Error("No chat model selected");
        }

        // 重发（编辑历史消息、错误对话框的 "Resubmit last message"）时，调用方
        // 不会显式传 attachments。此时从被替换的原消息里继承附件：路径在
        // metadata.attachments，内容在 message.content 的 <file_content> 块里。
        // 必须在 submitEditorAndInitAtIndex 清空 content 之前提取。
        const existingMessage =
          inputIndex >= 0 && inputIndex < state.session.history.length
            ? state.session.history[inputIndex].message
            : undefined;
        const filesToAttach =
          attachments ??
          (existingMessage
            ? extractAttachmentsFromMessage(existingMessage)
            : []);

        dispatch(
          submitEditorAndInitAtIndex({ index: inputIndex, editorState }),
        );

        dispatch(resetNextCodeBlockToApplyIndex());

        const defaultContextProviders =
          state.config.config.experimental?.defaultContext ?? [];

        // Resolve context providers and construct new history
        const {
          selectedContextItems,
          selectedCode,
          content,
          legacyCommandWithInput,
        } = await resolveEditorContent({
          editorState,
          modifiers,
          ideMessenger: extra.ideMessenger,
          defaultContextProviders,
          availableSlashCommands: state.config.config.slashCommands,
          dispatch,
          getState,
        });

        // symbols for both context items AND selected codeblocks
        const filesForSymbols = [
          ...selectedContextItems
            .filter((item) => item.uri?.type === "file" && item?.uri?.value)
            .map((item) => item.uri!.value),
          ...selectedCode.map((rif) => rif.filepath),
        ];
        void dispatch(updateFileSymbolsFromFiles(filesForSymbols));

        // Inject attached file content into message.content (the payload sent
        // to the LLM) as a trailing text part. The editorState is left clean so
        // the already-sent user message echoes back only what the user typed;
        // file chips are rendered from message.metadata.attachments instead.
        let finalContent = content;
        if (filesToAttach.length > 0) {
          const attachmentText = buildAttachedFilesText(filesToAttach);
          const parts: MessagePart[] = Array.isArray(content)
            ? (content as MessagePart[])
            : [{ type: "text", text: content as string } as TextMessagePart];
          parts.push({ type: "text", text: attachmentText });
          finalContent = parts;
        }
        const attachmentMeta: AttachmentMeta[] = filesToAttach.map((f) => ({
          name: f.name,
          path: f.path,
        }));

        dispatch(
          updateHistoryItemAtIndex({
            index: inputIndex,
            updates: {
              message: {
                role: "user",
                content: finalContent,
                id: uuidv4(),
                metadata:
                  attachmentMeta.length > 0
                    ? { attachments: attachmentMeta }
                    : undefined,
              },
              contextItems: selectedContextItems,
            },
          }),
        );

        unwrapResult(
          await dispatch(
            streamNormalInput({
              legacySlashCommandData: legacyCommandWithInput
                ? {
                    command: legacyCommandWithInput.command,
                    contextItems: selectedContextItems,
                    historyIndex: inputIndex,
                    input: legacyCommandWithInput.input,
                    selectedCode,
                  }
                : undefined,
            }),
          ),
        );
      }),
    ).unwrap();
    return succeeded;
  },
);
