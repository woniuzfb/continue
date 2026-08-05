import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers, MessagePart, TextMessagePart } from "core";

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

export const streamResponseThunk = createAsyncThunk<
  void,
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
    await dispatch(
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
        const filesToAttach = attachments ?? [];
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
    );
  },
);
