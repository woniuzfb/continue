import {
  ArrowPathIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  CubeIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/Auth";
import { AddModelForm } from "../../forms/AddModelForm";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { updateSelectedModelByRole } from "../../redux/thunks/updateSelectedModelByRole";
import { setSessionChatModelAndSave } from "../../redux/thunks/sessionChanges";
import { selectSessionChatModel } from "../../redux/selectors/sessions";
import type { SessionChatModelRef } from "../../redux/slices/sessionsSlice";
import { useSessionIsInEdit } from "../../redux/selectors/sessionView";
import {
  useIsVisibleSession,
  useSessionId,
} from "../mainInput/TipTapEditor/SessionScope";
import { getMetaKeyLabel, isMetaEquivalentKeyPressed } from "../../util";
import { CONFIG_ROUTES } from "../../util/navigation";
import {
  Button,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  useFontSize,
} from "../ui";
import { Divider } from "../ui/Divider";

interface ModelOptionProps {
  option: Option;
  idx: number;
  showMissingApiKeyMsg: boolean;
  isSelected?: boolean;
}

interface Option {
  value: string;
  title: string;
  apiKey?: string;
  sourceFile?: string;
  isAutoDetected?: boolean;
}

/**
 * 方案.md §7.5.4: the option value must be the stable identity, not the title. Encoding the ref as
 * a string keeps the Listbox (typed `string`) unchanged while making a duplicated title
 * unambiguous.
 */
function modelOptionKey(model: {
  title?: string;
  provider?: string;
  model?: string;
}): string {
  return JSON.stringify([
    model.title ?? "",
    model.provider ?? "",
    model.model ?? "",
  ]);
}

function modelRefFromOptionKey(key: string): SessionChatModelRef | undefined {
  try {
    const [title, provider, model] = JSON.parse(key);
    if (typeof title !== "string" || !title) return undefined;
    return {
      title,
      provider: String(provider ?? ""),
      model: String(model ?? ""),
    };
  } catch {
    return undefined;
  }
}

function modelSelectTitle(model: any): string {
  if (model?.title) return model?.title;
  if (model?.model !== undefined && model?.model.trim() !== "") {
    if (model?.class_name) {
      return `${model?.class_name} - ${model?.model}`;
    }
    return model?.model;
  }
  return model?.class_name;
}

/**makeshift way to close the headlessui listbox due to absence of open state on the listbox */
function closeDropDown(button: HTMLButtonElement | null) {
  if (!button) return;
  button.classList.add("hidden");
  setTimeout(() => {
    button.classList.remove("hidden");
  });
}

function ModelOption({
  option,
  idx,
  showMissingApiKeyMsg,
  isSelected,
}: ModelOptionProps) {
  const navigate = useNavigate();

  function handleOptionClick(e: any) {
    if (showMissingApiKeyMsg) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function handleConfigureClick(e: React.MouseEvent) {
    e.stopPropagation();
    navigate(CONFIG_ROUTES.MODELS);
  }

  return (
    <ListboxOption
      key={idx}
      disabled={showMissingApiKeyMsg}
      value={option.value}
      onClick={handleOptionClick}
      className={`group ${isSelected ? "bg-list-active text-list-active-foreground" : ""}`}
    >
      <div className="flex w-full items-center justify-between gap-5">
        <div className="flex items-center gap-2 py-0.5">
          <CubeIcon className="h-3 w-3 flex-shrink-0" />
          <span className="line-clamp-1">
            {option.title}
            {option.isAutoDetected && (
              <span className="text-description-muted ml-1.5 text-[10px] italic">
                (autodetected)
              </span>
            )}
            {showMissingApiKeyMsg && (
              <span className="ml-1.5 text-[10px] italic">
                (Missing API key)
              </span>
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-description-muted hover:enabled:text-foreground my-0 h-4 w-4 p-0 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={handleConfigureClick}
        >
          <Cog6ToothIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </ListboxOption>
  );
}

function ModelSelect() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  const isInEdit = useSessionIsInEdit();
  const activeSessionId = useSessionId();
  // 方案.md §九.2: one global listener per *visible* tab; a hidden tree must
  // not react to the model-selection shortcut.
  const visible = useIsVisibleSession();
  const config = useAppSelector((state) => state.config.config);
  const sessionChatModel = useAppSelector((state) =>
    selectSessionChatModel(state, activeSessionId),
  );
  const isConfigLoading = useAppSelector((state) => state.config.loading);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [sortedOptions, setSortedOptions] = useState<Option[]>([]);
  const { selectedProfile } = useAuth();
  const tinyFont = useFontSize(-4);

  let selectedModel = null;
  let allModels = null;
  if (isInEdit) {
    allModels = config.modelsByRole.edit;
    selectedModel = config.selectedModelByRole.edit;
  }
  if (!selectedModel) {
    // 方案.md §7.5.1/§7.5.4: the chat role belongs to **this** session, and the option identity is
    // its stable ref — a title can name two entries, and reading the global selection here made
    // the toolbar describe whichever window chose last.
    selectedModel = sessionChatModel;
  }
  if (!allModels || allModels.length === 0) {
    allModels = config.modelsByRole.chat;
  }

  // Sort so that options without an API key are at the end
  useEffect(() => {
    const alphaSort = options.sort((a, b) => a.title.localeCompare(b.title));
    const enabledOptions = alphaSort.filter((option) => option.apiKey !== "");
    const disabledOptions = alphaSort.filter((option) => option.apiKey === "");

    const sorted = [...enabledOptions, ...disabledOptions];

    setSortedOptions(sorted);
  }, [options]);

  useEffect(() => {
    setOptions(
      allModels.map((model) => {
        return {
          value: modelOptionKey(model),
          title: modelSelectTitle(model),
          apiKey: model.apiKey,
          sourceFile: model.sourceFile,
          isAutoDetected: model.isFromAutoDetect,
        };
      }),
    );
  }, [allModels]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "'" &&
        isMetaEquivalentKeyPressed(event as any) &&
        !event.shiftKey // To prevent collisions w/ assistant toggle logic
      ) {
        if (!selectedProfile) {
          return;
        }

        const direction = event.shiftKey ? -1 : 1;
        const currentIndex = options.findIndex(
          (option) =>
            option.value ===
            (selectedModel ? modelOptionKey(selectedModel) : undefined),
        );
        let nextIndex = (currentIndex + 1 * direction) % options.length;
        if (nextIndex < 0) nextIndex = options.length - 1;
        const newModelTitle = options[nextIndex].value;

        void dispatch(
          updateSelectedModelByRole({
            selectedProfile,
            role: "chat",
            modelTitle: newModelTitle,
          }),
        );
        // The session records its own model choice (方案.md §七.8).
        void dispatch(
          setSessionChatModelAndSave({
            sessionId: activeSessionId,
            chatModelTitle: newModelTitle,
          }),
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [visible, options, selectedModel]);

  function onClickAddModel(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    closeDropDown(buttonRef.current);

    dispatch(setShowDialog(true));
    dispatch(
      setDialogMessage(
        <AddModelForm
          onDone={() => {
            dispatch(setShowDialog(false));
          }}
        />,
      ),
    );
  }

  function onClickConfigureModels(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    closeDropDown(buttonRef.current);

    navigate(CONFIG_ROUTES.MODELS);
  }

  const hasNoModels = allModels?.length === 0;

  return (
    <Listbox
      onChange={async (val: string) => {
        // The option value is the stable identity key, so a duplicated title cannot be collapsed
        // into "the first entry with that title" (方案.md §7.5.4).
        const chatModelRef = modelRefFromOptionKey(val);
        if (!chatModelRef) return;
        if (modelOptionKey(selectedModel ?? {}) === val) return;
        void dispatch(
          updateSelectedModelByRole({
            selectedProfile,
            role: isInEdit ? "edit" : "chat",
            modelTitle: chatModelRef.title,
          }),
        );
        if (!isInEdit) {
          void dispatch(
            setSessionChatModelAndSave({
              sessionId: activeSessionId,
              chatModelRef,
            }),
          );
        }
      }}
    >
      <div className="relative flex">
        <ListboxButton
          data-testid="model-select-button"
          ref={buttonRef}
          className="text-description h-[18px] gap-1 border-none"
        >
          <span className="line-clamp-1 break-all hover:brightness-110">
            {modelSelectTitle(selectedModel) || "Select model"}
          </span>
          <ChevronDownIcon
            className="hidden h-2 w-2 flex-shrink-0 hover:brightness-110 min-[200px]:flex"
            aria-hidden="true"
          />
        </ListboxButton>
        <ListboxOptions className="min-w-[160px]">
          <div className="flex items-center justify-between px-1.5 py-1">
            <span className="text-description text-xs font-medium">Models</span>
            <div className="flex items-center gap-0.5">
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onClickConfigureModels(e);
                }}
                variant="ghost"
                size="sm"
                className="my-0 h-5 w-5 p-0"
              >
                <Cog6ToothIcon className="text-description h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="no-scrollbar max-h-[300px] overflow-y-auto">
            {isConfigLoading ? (
              <div className="text-description flex items-center gap-2 px-2 pb-2 pt-1 text-xs">
                <ArrowPathIcon className="animate-spin-slow h-3 w-3" />
                <span>Loading config</span>
              </div>
            ) : hasNoModels ? (
              <div className="text-description-muted px-2 py-4 text-center text-sm">
                No models configured
              </div>
            ) : (
              sortedOptions.map((option, idx) => (
                <ModelOption
                  option={option}
                  idx={idx}
                  key={idx}
                  showMissingApiKeyMsg={option.apiKey === ""}
                  isSelected={option.value === selectedModel?.title}
                />
              ))
            )}
          </div>

          {!isConfigLoading && (
            <>
              <Divider className="!mb-0" />
              <ListboxOption
                key={options.length}
                onClick={onClickAddModel}
                value={"addModel" as any}
                fontSizeModifier={-2}
                className="px-2 py-2"
              >
                <span className="text-description text-2xs flex flex-row items-center">
                  <PlusIcon className="mr-1.5 h-3.5 w-3.5" />
                  Add Chat model
                </span>
              </ListboxOption>

              <Divider className="!my-0" />
              <div className="text-description flex items-center justify-start p-2">
                <span className="block" style={{ fontSize: tinyFont }}>
                  <code>{getMetaKeyLabel()}'</code> to toggle model
                </span>
              </div>
            </>
          )}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

export default ModelSelect;
