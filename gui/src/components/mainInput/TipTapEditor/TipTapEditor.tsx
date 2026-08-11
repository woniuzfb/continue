import { DocumentIcon } from "@heroicons/react/24/outline";
import { Editor, EditorContent, JSONContent } from "@tiptap/react";
import { ContextProviderDescription, InputModifiers } from "core";
import { modelSupportsImages } from "core/llm/autodetect";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import useIsOSREnabled from "../../../hooks/useIsOSREnabled";
import useUpdatingRef from "../../../hooks/useUpdatingRef";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { selectSelectedChatModel } from "../../../redux/slices/configSlice";
import { setMainEditorDraft } from "../../../redux/slices/sessionSlice";
import InputToolbar, { ToolbarOptions } from "../InputToolbar";
import { ComboBoxItem, AttachedFile } from "../types";
import {
  isBinaryContent,
  isBinaryFileName,
  packBinaryToChunks,
  pad3,
  shouldPackAttachment,
} from "../util/binaryAttachments";
import { DragOverlay } from "./components/DragOverlay";
import { InputBoxDiv } from "./components/StyledComponents";
import { useMainEditor } from "./MainEditorProvider";
import "./TipTapEditor.css";
import { createEditorConfig, getPlaceholderText } from "./utils/editorConfig";
import { handleImageFile } from "./utils/imageUtils";
import { useEditorEventHandlers } from "./utils/keyHandlers";

/** Cap for packing a single binary attachment (~112 MB of raw data). Larger
 * files would freeze the webview; fall back to the legacy text attach. */
const MAX_PACK_B64_CHARS = 150_000_000;

/** Resolves with `fallback` when `promise` does not settle within `ms`.
 * Prevents protocol requests from hanging forever (e.g. a stale IDE
 * extension that does not handle a newly added message type). */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface TipTapEditorProps {
  availableContextProviders: ContextProviderDescription[];
  availableSlashCommands: ComboBoxItem[];
  isMainInput: boolean;
  onEnter: (
    editorState: JSONContent,
    modifiers: InputModifiers,
    editor: Editor,
    attachments?: AttachedFile[],
  ) => void | Promise<boolean>;
  editorState?: JSONContent;
  toolbarOptions?: ToolbarOptions;
  placeholder?: string;
  historyKey: string;

  // TODO: This isn't actually used anywhere in this component, but it appears
  // to be pulled into some of our TipTap extensions.
  inputId: string;

  /** Whether there are pending attached files. When true, an empty editor is
   * still considered submittable so a user can send attachments-only messages. */
  hasAttachments?: boolean;
}

export const TIPPY_DIV_ID = "tippy-js-div";

/**
 * Small square file chip rendered inline with the toolbar buttons.
 * Styled after Cline's Thumbnails file chip: a compact square with a
 * folded-corner file icon, the filename truncated below it, and a gray
 * circular "x" delete button at the top-right on hover.
 */
function AttachedFileChip({
  file,
  onRemove,
}: {
  file: AttachedFile;
  onRemove: () => void;
}) {
  return (
    <div className="group relative flex shrink-0">
      <div
        className="border-vsc-input-border bg-vsc-editor-background flex flex-col items-center justify-center overflow-hidden rounded border"
        style={{ width: 28, height: 28 }}
        title={file.name}
      >
        <DocumentIcon className="text-vsc-foreground h-2.5 w-2.5" />
        <span
          className="text-vsc-foreground mt-px block max-w-[90%] truncate text-center"
          style={{ fontSize: 6, lineHeight: 1 }}
        >
          {file.name}
        </span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute flex cursor-pointer items-center justify-center rounded-full opacity-0 group-hover:opacity-100"
        style={{
          top: -4,
          right: -4,
          width: 14,
          height: 14,
          backgroundColor: "#4d4d4d",
          border: "1px solid var(--vscode-editor-background, #1e1e1e)",
        }}
        aria-label="Remove attached file"
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            position: "relative",
            width: 7,
            height: 7,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: 7,
              height: 1.5,
              backgroundColor: "#ffffff",
              transform: "translate(-50%, -50%) rotate(45deg)",
              transformOrigin: "center center",
            }}
          />
          <span
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: 7,
              height: 1.5,
              backgroundColor: "#ffffff",
              transform: "translate(-50%, -50%) rotate(-45deg)",
              transformOrigin: "center center",
            }}
          />
        </span>
      </button>
    </div>
  );
}

function TipTapEditorInner(props: TipTapEditorProps) {
  const dispatch = useAppDispatch();
  const mainEditorContext = useMainEditor();

  // --- Attached files (Upload File via "+") ---
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  // Ref so the closure captured by the editor's onEnter always sees the latest
  // attached files. The onEnter returned by createEditorConfig is captured once
  // by the Paragraph Enter keybinding, so we must read through a ref.
  const attachedFilesRef = useUpdatingRef(attachedFiles);

  const ideMessenger = useContext(IdeMessengerContext);
  const isOSREnabled = useIsOSREnabled();

  const defaultModel = useAppSelector(selectSelectedChatModel);
  // Attachments larger than this (real byte size) are split into base64
  // chunks + manifest; configurable via ui.attachmentSplitThresholdMB.
  const inlineLimitBytes = useAppSelector(
    (state) =>
      (state.config.config.ui?.attachmentSplitThresholdMB ?? 1) * 1024 * 1024,
  );
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const historyLength = useAppSelector((store) => store.session.history.length);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const mainEditorDraft = useAppSelector(
    (store) => store.session.mainEditorDraft,
  );

  // For the main input, fall back to any persisted draft so that text entered
  // before navigating away (e.g. to /history or /config) is restored when the
  // Chat route remounts. `mainEditorContentTrigger` (set by edit-mode flows)
  // still takes precedence via the MainEditorProvider effect.
  const effectiveEditorState = props.isMainInput
    ? (props.editorState ?? mainEditorDraft)
    : props.editorState;

  // Wrap props.onEnter so that when attached files are present, they are
  // forwarded as a fourth argument (attachments) instead of being injected
  // into editorState. The editorState stays clean so the already-sent user
  // message only echoes back what the user typed; the file content is injected
  // into message.content downstream (in streamResponseThunk) and the file
  // metadata is stored on message.metadata for the UI to render chips.
  // We read through attachedFilesRef so the closure captured by the editor's
  // Enter keybinding always sees the latest value. The chips are cleared
  // optimistically (same as the editor text), but if the send fails (error
  // interrupt, handled by streamThunkWrapper which reports success via a
  // boolean), the previously selected files are restored so the user does not
  // have to pick them again.
  const wrappedOnEnter: typeof props.onEnter = async (
    editorState,
    modifiers,
    editor,
  ) => {
    const files = attachedFilesRef.current;
    if (files.length > 0) {
      setAttachedFiles([]);
      const result = await props.onEnter(editorState, modifiers, editor, files);
      if (result === false) {
        // Send was interrupted by an error: bring the files back. If the user
        // already picked new files while the send was in flight, keep those.
        setAttachedFiles((prev) => (prev.length === 0 ? files : prev));
      }
      return result === false ? false : true;
    }
    const result = await props.onEnter(editorState, modifiers, editor);
    return result === false ? false : true;
  };

  const { editor, onEnter } = createEditorConfig({
    props: {
      ...props,
      editorState: effectiveEditorState,
      onEnter: wrappedOnEnter,
      hasAttachments: attachedFiles.length > 0,
    },
    ideMessenger,
    dispatch,
  });

  // Register the main editor with the provider
  useEffect(() => {
    if (props.isMainInput && editor) {
      mainEditorContext.setMainEditor(editor);
      mainEditorContext.setInputId(props.inputId);
      mainEditorContext.onEnterRef.current = onEnter;
    }
  }, [
    editor,
    props.isMainInput,
    props.inputId,
    mainEditorContext,
    onEnter,
    isStreaming,
  ]);

  const [shouldHideToolbar, setShouldHideToolbar] = useState(true);
  // Collapse the editor content area to a minimal height so that long drafts
  // don't push the chat history out of view.
  const [isEditorCollapsed, setIsEditorCollapsed] = useState(false);
  const toggleEditorCollapse = useCallback(() => {
    setIsEditorCollapsed((v) => !v);
  }, []);

  useEffect(() => {
    if (!editor) {
      return;
    }
    const placeholder = getPlaceholderText(props.placeholder, historyLength);
    const placeholderExt = editor.extensionManager.extensions.find(
      (e) => e.name === "placeholder",
    ) as any;
    if (placeholderExt) {
      placeholderExt.options["placeholder"] = placeholder;
      editor.view.dispatch(editor.state.tr);
    }
  }, [editor, props.placeholder, historyLength]);

  // Persist the main input draft on unmount so it survives route changes
  // (e.g. navigating to /history or /config and back). It is restored via the
  // editor's initial content (effectiveEditorState above).
  useEffect(() => {
    if (!props.isMainInput) {
      return;
    }
    return () => {
      if (editor && !editor.isDestroyed) {
        dispatch(setMainEditorDraft(editor.getJSON()));
      }
    };
  }, [props.isMainInput, editor, dispatch]);

  useEffect(() => {
    if (isInEdit) {
      setShouldHideToolbar(false);
    }
  }, [isInEdit]);

  const editorFocusedRef = useUpdatingRef(editor?.isFocused, [editor]);

  useEffect(() => {
    if (props.isMainInput) {
      /**
       * I have a strong suspicion that many of the other focus
       * commands are redundant, especially the ones inside
       * useTimeout.
       */
      // If the editor was restored from a draft, place the cursor at the end
      // instead of the default (start).
      editor?.commands.focus(editor?.isEmpty ? undefined : "end");
    }
  }, [props.isMainInput, editor]);

  // Re-focus main input after done generating
  useEffect(() => {
    if (editor && !isStreaming && props.isMainInput && document.hasFocus()) {
      editor.commands.focus(undefined, { scrollIntoView: false });
    }
  }, [props.isMainInput, isStreaming, editor]);

  // Recovery mechanism: ensure historical inputs regain editability when streaming ends
  useEffect(() => {
    if (!isStreaming && !props.isMainInput && editor) {
      // Small delay to ensure editor state has settled after streaming transition
      const timeoutId = setTimeout(() => {
        if (editor && !editor.isDestroyed) {
          // Force re-enable the editor
          editor.setOptions({ editable: true });
          // Trigger view update to refresh editor state
          editor.view.dispatch(editor.state.tr);
        }
      }, 100);

      return () => clearTimeout(timeoutId);
    }
  }, [isStreaming, props.isMainInput]);

  const [showDragOverMsg, setShowDragOverMsg] = useState(false);

  const [activeKey, setActiveKey] = useState<string | null>(null);

  const insertCharacterWithWhitespace = useCallback(
    (char: string) => {
      if (!editor) {
        return;
      }
      const text = editor.getText();
      if (!text.endsWith(char)) {
        if (text.length > 0 && !text.endsWith(" ")) {
          editor.commands.insertContent(` ${char}`);
        } else {
          editor.commands.insertContent(char);
        }
      }
    },
    [editor],
  );

  const { handleKeyUp, handleKeyDown } = useEditorEventHandlers({
    editor,
    isOSREnabled: isOSREnabled,
    editorFocusedRef,
    setActiveKey,
  });

  const blurTimeout = useRef<NodeJS.Timeout | null>(null);
  const cancelBlurTimeout = useCallback(() => {
    if (blurTimeout.current) {
      clearTimeout(blurTimeout.current);
      blurTimeout.current = null;
    }
  }, [blurTimeout]);

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      if (isInEdit) {
        return;
      }
      // Check if the new focus target is within our InputBoxDiv
      const currentTarget = e.currentTarget;
      const relatedTarget = e.relatedTarget as Node | null;

      if (relatedTarget && currentTarget?.contains(relatedTarget)) {
        return;
      }
      // Otherwise give e.g. listboxes a chance to cancel the hiding
      blurTimeout.current = setTimeout(() => {
        setShouldHideToolbar(true);
      }, 100);
    },
    [isInEdit, blurTimeout],
  );

  const handleFocus = useCallback(() => {
    cancelBlurTimeout();
    setShouldHideToolbar(false);
  }, [cancelBlurTimeout]);

  // Open the IDE's native file picker and read the selected file as text.
  // We use the IDE dialog (rather than a hidden <input type="file">) so that
  // we get the real absolute path, which is shown in the appended
  // <file_content path="..."> block.
  const handleUploadFileClick = useCallback(() => {
    void ideMessenger
      .request("showOpenDialog", {
        selectFiles: true,
        selectFolders: false,
        canSelectMany: true,
        title: "Upload File",
      })
      .then((res) => {
        if (res.status !== "success") {
          console.error("showOpenDialog failed", res.error);
          return;
        }
        const paths = res.content ?? [];
        if (paths.length === 0) {
          return;
        }
        Promise.all(
          paths.map(async (path): Promise<AttachedFile[]> => {
            const name = path.split(/[/\\]/).pop() ?? path;
            // readFile uses vscode.Uri.parse which expects a URI string
            // (e.g. "file:///path/to/file"), but showOpenDialog returns
            // fsPath (e.g. "/path/to/file"). Convert to URI so readFile
            // doesn't silently return "" via its catch block.
            const fileUri = path.startsWith("file:") ? path : `file://${path}`;
            let content = "";
            try {
              content = await ideMessenger.ide.readFile(fileUri);
            } catch (e) {
              console.error("Failed to read uploaded file", e);
            }
            try {
              // The REAL byte size decides whether to pack: readFile text is
              // truncated at 10MB and returns "" past 100MB, so it can't be
              // trusted for large files. getFileStats is cheap metadata;
              // fall back to content length if the IDE doesn't support it.
              let fileSize: number | undefined;
              try {
                const stats = await ideMessenger.ide.getFileStats([fileUri]);
                fileSize = stats?.[fileUri]?.size;
              } catch (e) {
                console.warn("getFileStats failed, using content length", e);
              }
              // Binary/archive files and ANY large file can't be inlined as
              // UTF-8 text (mangled by the text decode, truncated by the IDE,
              // or too big for the context). Pack them instead: base64 ->
              // chunks + sha256 manifest, preserving the ORIGINAL bytes (no
              // re-packaging), attached through the normal flow. The chunks
              // are pure-ASCII base64, so they survive text-ified channels
              // intact and can be verified/rejoined via the manifest. The
              // threshold comes from ui.attachmentSplitThresholdMB (default
              // 1 MB).
              if (
                shouldPackAttachment(name, content, fileSize, inlineLimitBytes)
              ) {
                // The IDE extension may not know readBinaryBase64 yet (stale
                // build): the protocol request would otherwise hang forever.
                // Time out and fall back to the legacy text attach.
                const rawBase64 = await withTimeout(
                  ideMessenger.ide.readBinaryBase64(fileUri),
                  4000,
                  "",
                );
                if (rawBase64 && rawBase64.length <= MAX_PACK_B64_CHARS) {
                  const { chunks, manifest } = await packBinaryToChunks({
                    name,
                    path,
                    rawBase64,
                  });
                  return [
                    ...chunks.map((chunk, i) => ({
                      name: `${name}.b64.${pad3(i)}`,
                      path: `${path}.b64.${pad3(i)}`,
                      content: chunk,
                    })),
                    {
                      name: `${name}.b64.manifest.txt`,
                      path: `${path}.b64.manifest.txt`,
                      content: manifest,
                    },
                  ];
                }
                if (rawBase64.length > MAX_PACK_B64_CHARS) {
                  console.warn(
                    `Skipped binary packing for ${name}: payload too large (${rawBase64.length} b64 chars)`,
                  );
                } else {
                  console.warn(
                    `readBinaryBase64 unavailable for ${name}; attaching as text`,
                  );
                }
              }
            } catch (e) {
              console.error("Binary packing failed, attaching as text", e);
            }
            return [{ name, path, content } satisfies AttachedFile];
          }),
        )
          .then((fileGroups) => {
            setAttachedFiles((prev) => [...prev, ...fileGroups.flat()]);
          })
          .catch((e) => {
            console.error("Failed to process uploaded files", e);
          });
      });
  }, [ideMessenger, inlineLimitBytes]);

  // Single attached file renders inline with the toolbar buttons (leftExtra).
  // Memoize so the element reference is stable across re-renders (e.g. while
  // typing), letting InputToolbar's React.memo skip unnecessary re-renders.
  const singleFileLeftExtra = useMemo(() => {
    if (attachedFiles.length !== 1) return undefined;
    const file = attachedFiles[0];
    return (
      <AttachedFileChip file={file} onRemove={() => setAttachedFiles([])} />
    );
  }, [attachedFiles]);

  return (
    <InputBoxDiv
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      className={
        !props.isMainInput && shouldHideToolbar
          ? "cursor-pointer"
          : "cursor-text"
      }
      onClick={() => {
        editor?.commands.focus();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setShowDragOverMsg(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) {
          if (e.shiftKey) {
            setShowDragOverMsg(false);
          } else {
            setTimeout(() => setShowDragOverMsg(false), 2000);
          }
        }
      }}
      onDragEnter={() => {
        setShowDragOverMsg(true);
      }}
      onDrop={(event) => {
        setShowDragOverMsg(false);
        if (
          !defaultModel ||
          !modelSupportsImages(
            defaultModel.provider,
            defaultModel.model,
            defaultModel.title,
            defaultModel.capabilities,
          )
        ) {
          return;
        }
        let file = event.dataTransfer.files[0];
        void handleImageFile(ideMessenger, file).then((result) => {
          if (!editor) {
            return;
          }
          if (result) {
            const [_, dataUrl] = result;
            const { schema } = editor.state;
            const node = schema.nodes.image.create({ src: dataUrl });
            const tr = editor.state.tr.insert(0, node);
            editor.view.dispatch(tr);
          }
        });
        event.preventDefault();
      }}
    >
      <div
        className={`px-2.5 pb-1 pt-2 ${
          attachedFiles.length > 1 ? "has-attachments" : ""
        }`}
      >
        <EditorContent
          className={`scroll-container ${
            props.isMainInput
              ? isEditorCollapsed
                ? "max-h-[36px] overflow-hidden"
                : "max-h-[calc(100vh-140px)] overflow-y-scroll"
              : "overflow-y-scroll"
          }`}
          spellCheck={false}
          editor={editor}
          onClick={(event) => {
            event.stopPropagation();
          }}
        />
        {attachedFiles.length > 1 && (
          // Single row, horizontal scroll: chips must never grow vertically,
          // otherwise the send toolbar below gets pushed off screen.
          <div className="-mb-2 mt-1 flex max-h-[32px] flex-nowrap gap-1 overflow-x-auto">
            {attachedFiles.map((file, idx) => (
              <AttachedFileChip
                key={`${file.path}-${idx}`}
                file={file}
                onRemove={() =>
                  setAttachedFiles((prev) => prev.filter((_, i) => i !== idx))
                }
              />
            ))}
          </div>
        )}
        <InputToolbar
          isMainInput={props.isMainInput}
          toolbarOptions={props.toolbarOptions}
          activeKey={activeKey}
          hidden={shouldHideToolbar && !props.isMainInput}
          onAddContextItem={() => insertCharacterWithWhitespace("@")}
          onUploadFile={handleUploadFileClick}
          onEnter={onEnter}
          onImageFileSelected={(file) => {
            void handleImageFile(ideMessenger, file).then((result) => {
              if (!editor) {
                return;
              }
              if (result) {
                const [_, dataUrl] = result;
                const { schema } = editor.state;
                const node = schema.nodes.image.create({ src: dataUrl });
                editor.commands.command(({ tr }) => {
                  tr.insert(0, node);
                  return true;
                });
              }
            });
          }}
          disabled={isStreaming}
          leftExtra={singleFileLeftExtra}
          isEditorCollapsed={isEditorCollapsed}
          onToggleCollapse={toggleEditorCollapse}
        />
      </div>

      {showDragOverMsg &&
        modelSupportsImages(
          defaultModel?.provider || "",
          defaultModel?.model || "",
          defaultModel?.title,
          defaultModel?.capabilities,
        ) && (
          <DragOverlay show={showDragOverMsg} setShow={setShowDragOverMsg} />
        )}
      <div id={TIPPY_DIV_ID} className="fixed z-50" />
    </InputBoxDiv>
  );
}

function toolbarOptionsEqual(a?: ToolbarOptions, b?: ToolbarOptions) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.hideAddContext === b.hideAddContext &&
    a.hideImageUpload === b.hideImageUpload &&
    a.hideUploadFile === b.hideUploadFile &&
    a.hideUseCodebase === b.hideUseCodebase &&
    a.hideSelectModel === b.hideSelectModel &&
    a.enterText === b.enterText
  );
}

const MemoInner = memo(
  TipTapEditorInner,
  (prev, next) =>
    prev.isMainInput === next.isMainInput &&
    prev.placeholder === next.placeholder &&
    prev.historyKey === next.historyKey &&
    prev.inputId === next.inputId &&
    toolbarOptionsEqual(prev.toolbarOptions, next.toolbarOptions) &&
    (prev.availableContextProviders?.length || 0) ===
      (next.availableContextProviders?.length || 0) &&
    (prev.availableSlashCommands?.length || 0) ===
      (next.availableSlashCommands?.length || 0),
);

export function TipTapEditor(props: TipTapEditorProps) {
  return (
    <div className="relative w-full">
      <MemoInner {...props} />
    </div>
  );
}
