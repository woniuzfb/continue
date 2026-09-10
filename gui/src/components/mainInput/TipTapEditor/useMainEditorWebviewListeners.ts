import { Editor } from "@tiptap/react";
import { InputModifiers } from "core";
import { rifWithContentsToContextItem } from "core/commands/util";
import { MutableRefObject } from "react";
import { useWebviewListener } from "../../../hooks/useWebviewListener";
import { useAppSelector } from "../../../redux/hooks";
import { setSessionCodeToEdit } from "../../../redux/slices/sessionsSlice";
import { setSessionNewestToolbarPreviewForInput } from "../../../redux/slices/sessionsSlice";
import { AppDispatch } from "../../../redux/store";

import { CodeBlock, PromptBlock } from "./extensions";
import { insertCurrentFileContextMention } from "./utils/insertCurrentFileContextMention";
import { useSessionIsInEdit } from "../../../redux/selectors/sessionView";
import { flushSessionSave } from "../../../redux/thunks/sessionPersistence";
import { createAndActivateSession } from "../../../redux/thunks/sessionActivation";
import { openSessionTab } from "../../../redux/thunks/sessionLifecycle";

/**
 * Hook for setting up main editor specific webview listeners
 */
export function useMainEditorWebviewListeners({
  editor,
  onEnterRef,
  dispatch,
  historyLength,
  sessionId,
  inputId,
  editorFocusedRef,
}: {
  editor: Editor | null;
  onEnterRef: MutableRefObject<(modifiers: InputModifiers) => void>;
  dispatch: AppDispatch;
  historyLength: number;
  sessionId: string;
  inputId: string;
  editorFocusedRef: MutableRefObject<boolean | undefined>;
}) {
  const activeContextProviders = useAppSelector(
    (state) => state.config.config.contextProviders,
  );
  const useCurrentFileAsContext = useAppSelector(
    (state) => state.config.config.experimental?.useCurrentFileAsContext,
  );
  const isInEdit = useSessionIsInEdit();

  useWebviewListener(
    "isContinueInputFocused",
    async () => {
      return !!editorFocusedRef.current;
    },
    [editorFocusedRef],
  );

  useWebviewListener(
    "userInput",
    async (data) => {
      if (!editor) return;
      editor.commands.insertContent(data.input);
      onEnterRef.current({ useCodebase: false, noContext: true });
    },
    [editor, onEnterRef.current],
  );

  useWebviewListener("jetbrains/editorInsetRefresh", async () => {
    editor?.chain().clearContent().focus().run();
  });

  useWebviewListener(
    "focusContinueInput",
    async () => {
      dispatch(setSessionCodeToEdit({ sessionId, codeToEdit: [] }));

      if (historyLength > 0) {
        // Explicit flush — not a tab switch and not a new session.
        await dispatch(flushSessionSave({ sessionId }));
      }

      setTimeout(() => {
        editor?.commands.blur();
        editor?.commands.focus("end");
      }, 20);
    },
    [historyLength, editor, dispatch],
  );

  useWebviewListener(
    "focusContinueInputWithoutClear",
    async () => {
      setTimeout(() => {
        editor?.commands.focus("end");
      }, 20);
    },
    [editor],
  );

  useWebviewListener(
    "focusContinueInputWithNewSession",
    async () => {
      await dispatch(createAndActivateSession({ origin: "new" }));

      setTimeout(() => {
        editor?.commands.focus("end");
      }, 20);
    },
    [editor, dispatch],
  );

  useWebviewListener(
    "highlightedCode",
    async (data) => {
      if (!editor) return;

      const contextItem = rifWithContentsToContextItem(
        data.rangeInFileWithContents,
      );

      let index = 0;
      for (const el of editor.getJSON()?.content ?? []) {
        // Prevent exact duplicate code blocks
        if (el.attrs?.item?.name === contextItem.name) {
          return;
        }

        if (el.type === CodeBlock.name || el.type === PromptBlock.name) {
          index += 2;
        } else {
          break;
        }
      }

      editor
        .chain()
        .insertContentAt(index, {
          type: CodeBlock.name,
          attrs: {
            item: contextItem,
            inputId,
          },
        })
        .run();

      dispatch(
        setSessionNewestToolbarPreviewForInput({
          sessionId,
          inputId,
          contextItemId: contextItem.id.itemId,
        }),
      );

      if (data.prompt) {
        editor.commands.focus("end");
        editor.commands.insertContent(data.prompt);
      }

      if (data.shouldRun) {
        onEnterRef.current({ useCodebase: false, noContext: true });
      }

      setTimeout(() => {
        editor.commands.blur();
        editor.commands.focus("end");
      }, 20);
    },
    [editor, inputId, onEnterRef.current],
  );

  useWebviewListener(
    "isContinueInputFocused",
    async () => {
      return !!editorFocusedRef.current;
    },
    [editorFocusedRef],
  );

  useWebviewListener(
    "focusContinueSessionId",
    async (data) => {
      if (!data.sessionId) return;

      await dispatch(openSessionTab({ sessionId: data.sessionId }));
    },
    [],
  );

  useWebviewListener(
    "newSession",
    async () => {
      // do not insert current file context mention if we are in edit mode or if addFileContext is disabled
      if (!editor || isInEdit || !useCurrentFileAsContext) return;
      insertCurrentFileContextMention(editor, activeContextProviders);
    },
    [editor, activeContextProviders, isInEdit, useCurrentFileAsContext],
  );

  useWebviewListener(
    "addToChat",
    async (data) => {
      if (!editor) return;
      let chain = editor.chain();

      for (let mention of data.data) {
        chain
          .insertContent({
            type: "mention",
            attrs: {
              id: mention.fullPath,
              query: mention.fullPath,
              itemType: mention.type,
              label: mention.name,
            },
          })
          .insertContent(" ");
      }

      chain.run();
    },
    [editor],
  );
}
