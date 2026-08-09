import { Editor, JSONContent } from "@tiptap/react";
import { DocumentIcon } from "@heroicons/react/24/outline";
import {
  ContextItemWithId,
  InputModifiers,
  RuleMetadata,
  SlashCommandSource,
} from "core";
import { memo, useContext, useMemo } from "react";
import { defaultBorderRadius, vscBackground } from "..";
import { useAppSelector } from "../../redux/hooks";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { selectSlashCommandComboBoxInputs } from "../../redux/selectors";
import { ContextItemsPeek } from "./belowMainInput/ContextItemsPeek";
import { RulesPeek } from "./belowMainInput/RulesPeek";
import { GradientBorder } from "./GradientBorder";
import { ToolbarOptions } from "./InputToolbar";
import { Lump } from "./Lump";
import { TipTapEditor } from "./TipTapEditor";
import { AttachmentMeta, AttachedFile } from "./types";

interface ContinueInputBoxProps {
  isLastUserInput: boolean;
  isMainInput?: boolean;
  onEnter: (
    editorState: JSONContent,
    modifiers: InputModifiers,
    editor: Editor,
    attachments?: AttachedFile[],
  ) => void | Promise<boolean>;
  editorState?: JSONContent;
  contextItems?: ContextItemWithId[];
  appliedRules?: RuleMetadata[];
  /** Already-sent attachments (read from message.metadata) rendered as
   * read-only file chips below the message box. Clicking a chip opens the
   * file in the IDE. Only relevant for non-main (history) inputs. */
  attachments?: AttachmentMeta[];
  hidden?: boolean;
  inputId: string; // used to keep track of things per input in redux
}

const EDIT_DISALLOWED_CONTEXT_PROVIDERS = [
  "codebase",
  "tree",
  "open",
  "web",
  "diff",
  "folder",
  "search",
  "debugger",
  "repo-map",
];

const EDIT_ALLOWED_SLASH_COMMAND_SOURCES: SlashCommandSource[] = [
  "yaml-prompt-block",
  "mcp-prompt",
  "prompt-file-v1",
  "prompt-file-v2",
  "invokable-rule",
  "json-custom-command",
];

function ContinueInputBox(props: ContinueInputBoxProps) {
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const ideMessenger = useContext(IdeMessengerContext);
  const availableSlashCommands = useAppSelector(
    selectSlashCommandComboBoxInputs,
  );
  const availableContextProviders = useAppSelector(
    (state) => state.config.config.contextProviders,
  );
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const editModeState = useAppSelector((state) => state.editModeState);

  const filteredSlashCommands = useMemo(() => {
    if (isInEdit) {
      return availableSlashCommands.filter((cmd) =>
        cmd.slashCommandSource
          ? EDIT_ALLOWED_SLASH_COMMAND_SOURCES.includes(cmd.slashCommandSource)
          : false,
      );
    }
    return availableSlashCommands;
  }, [isInEdit, availableSlashCommands]);

  const filteredContextProviders = useMemo(() => {
    if (isInEdit) {
      return (
        availableContextProviders?.filter(
          (provider) =>
            !EDIT_DISALLOWED_CONTEXT_PROVIDERS.includes(provider.title),
        ) ?? []
      );
    }

    return availableContextProviders ?? [];
  }, [availableContextProviders, isInEdit]);

  const historyKey = isInEdit ? "edit" : "chat";
  const placeholder = isInEdit ? "Edit selected code" : undefined;

  const toolbarOptions: ToolbarOptions = useMemo(() => {
    if (isInEdit) {
      return {
        hideAddContext: false,
        hideImageUpload: false,
        hideUseCodebase: true,
        hideSelectModel: false,
        enterText:
          editModeState.applyState.status === "done" ? "Retry" : "Edit",
      } as ToolbarOptions;
    }
    // Stable empty object to avoid re-renders from identity changes
    return {} as ToolbarOptions;
  }, [isInEdit, editModeState.applyState.status]);

  const { appliedRules = [], contextItems = [], attachments = [] } = props;

  return (
    <div
      className={`${props.hidden ? "hidden" : ""}`}
      data-testid={`continue-input-box-${props.inputId}`}
    >
      <div className={`relative flex flex-col px-2`}>
        {props.isMainInput && <Lump />}
        <GradientBorder
          loading={isStreaming && (props.isLastUserInput || isInEdit) ? 1 : 0}
          borderColor={
            isStreaming && (props.isLastUserInput || isInEdit)
              ? undefined
              : vscBackground
          }
          borderRadius={defaultBorderRadius}
        >
          <TipTapEditor
            editorState={props.editorState}
            onEnter={props.onEnter}
            placeholder={placeholder}
            isMainInput={props.isMainInput ?? false}
            availableContextProviders={filteredContextProviders}
            availableSlashCommands={filteredSlashCommands}
            historyKey={historyKey}
            toolbarOptions={toolbarOptions}
            inputId={props.inputId}
          />
        </GradientBorder>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 px-1 pb-1 pt-1">
            {attachments.map((file, idx) => (
              <button
                key={`${file.path}-${idx}`}
                type="button"
                title={file.path}
                onClick={(e) => {
                  e.stopPropagation();
                  ideMessenger.post("openFile", { path: file.path });
                }}
                className="border-vsc-input-border bg-vsc-editor-background flex shrink-0 cursor-pointer flex-col items-center justify-center overflow-hidden rounded border transition-colors hover:brightness-125"
                style={{ width: 28, height: 28 }}
              >
                <DocumentIcon className="text-vsc-foreground h-2.5 w-2.5" />
                <span
                  className="text-vsc-foreground mt-px block max-w-[90%] truncate text-center"
                  style={{ fontSize: 6, lineHeight: 1 }}
                >
                  {file.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {(appliedRules.length > 0 || contextItems.length > 0) && (
        <div className="mt-2 flex flex-col">
          <RulesPeek appliedRules={props.appliedRules} />
          <ContextItemsPeek
            contextItems={props.contextItems}
            isCurrentContextPeek={props.isLastUserInput}
          />
        </div>
      )}
    </div>
  );
}

export default memo(ContinueInputBox);
