import {
  CheckIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import { MessageModes } from "core";
import {
  isRecommendedAgentModel,
  isRecommendedAgentProvider,
} from "core/llm/toolSupport";
import { useCallback, useEffect, useMemo } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { setActiveSessionModeAndSave } from "../../redux/thunks/sessionChanges";
import { useSessionMode } from "../../redux/selectors/sessionView";
import {
  useIsVisibleSession,
  useSessionId,
} from "../mainInput/TipTapEditor/SessionScope";
import { getFontSize, getMetaKeyLabel } from "../../util";
import { ToolTip } from "../gui/Tooltip";
import { useMainEditor } from "../mainInput/TipTapEditor";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "../ui";
import { ModeIcon } from "./ModeIcon";

export function ModeSelect() {
  const dispatch = useAppDispatch();
  const sessionId = useSessionId();
  // 方案.md §九.2: Cmd+. is a global shortcut, but every mounted tab registers
  // its own listener — without a visibility gate the mode would cycle once per
  // open tab.
  const visible = useIsVisibleSession();
  const mode = useSessionMode();
  const selectedModel = useAppSelector(selectSelectedChatModel);

  const isGoodAtAgentMode = useMemo(() => {
    if (!selectedModel) {
      return undefined;
    }
    return (
      isRecommendedAgentProvider(selectedModel.provider) ||
      isRecommendedAgentModel(selectedModel.model)
    );
  }, [selectedModel]);

  const { mainEditor } = useMainEditor();
  const metaKeyLabel = useMemo(() => {
    return getMetaKeyLabel();
  }, []);

  const effectiveMode: MessageModes = mode === "chat" ? "plan" : mode;

  const cycleMode = useCallback(() => {
    if (effectiveMode === "plan") {
      void dispatch(setActiveSessionModeAndSave({ mode: "agent" }));
    } else if (effectiveMode === "agent") {
      void dispatch(setActiveSessionModeAndSave({ mode: "agent-full" }));
    } else {
      void dispatch(setActiveSessionModeAndSave({ mode: "plan" }));
    }
    // Only focus main editor if another one doesn't already have focus
    if (!document.activeElement?.classList?.contains("ProseMirror")) {
      mainEditor?.commands.focus();
    }
  }, [effectiveMode, mainEditor, dispatch]);

  const selectMode = useCallback(
    (newMode: MessageModes) => {
      if (newMode === effectiveMode) {
        return;
      }

      void dispatch(setActiveSessionModeAndSave({ mode: newMode }));

      mainEditor?.commands.focus();
    },
    [effectiveMode, mainEditor, dispatch],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "." && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void cycleMode();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [visible, cycleMode]);

  const notGreatAtAgent = (mode: string) => (
    <>
      <ToolTip
        style={{
          zIndex: 200001, // in front of listbox
        }}
        className="flex items-center gap-1"
        content={`${mode} might not work well with this model.`}
      >
        <ExclamationTriangleIcon className="text-warning h-2.5 w-2.5" />
      </ToolTip>
    </>
  );

  return (
    <Listbox value={effectiveMode} onChange={selectMode}>
      <div className="relative">
        <ListboxButton
          data-testid="mode-select-button"
          className="xs:px-2 text-description bg-lightgray/20 gap-1 rounded-full border-none px-1.5 py-0.5 transition-colors duration-200 hover:brightness-110"
        >
          <ModeIcon mode={effectiveMode} />
          <span className="hidden sm:line-clamp-1 sm:break-all">
            {effectiveMode === "agent-full"
              ? "Full Agent"
              : effectiveMode === "agent"
                ? "Agent"
                : "Plan"}
          </span>
          <ChevronDownIcon
            className="h-2 w-2 flex-shrink-0"
            aria-hidden="true"
          />
        </ListboxButton>
        <ListboxOptions className="min-w-32 max-w-48">
          <ListboxOption value="plan" className={"gap-1"}>
            <div className="flex flex-row items-center gap-1.5">
              <ModeIcon mode="plan" />
              <span className="">Plan</span>
              <ToolTip
                style={{
                  zIndex: 200001,
                }}
                content="Read-only mode (仅可查看)"
              >
                <InformationCircleIcon className="h-2.5 w-2.5 flex-shrink-0" />
              </ToolTip>
            </div>
            {!isGoodAtAgentMode && notGreatAtAgent("Plan")}
            <CheckIcon
              className={`ml-auto h-3 w-3 ${effectiveMode === "plan" ? "" : "opacity-0"}`}
            />
          </ListboxOption>

          <ListboxOption value="agent" className={"gap-1"}>
            <div className="flex flex-row items-center gap-1.5">
              <ModeIcon mode="agent" />
              <span className="">Agent</span>
              <ToolTip
                style={{
                  zIndex: 200001,
                }}
                content="Workspace write mode (工作区内修改)"
              >
                <InformationCircleIcon className="h-2.5 w-2.5 flex-shrink-0" />
              </ToolTip>
            </div>
            {!isGoodAtAgentMode && notGreatAtAgent("Agent")}
            <CheckIcon
              className={`ml-auto h-3 w-3 ${effectiveMode === "agent" ? "" : "opacity-0"}`}
            />
          </ListboxOption>

          <ListboxOption value="agent-full" className={"gap-1"}>
            <div className="flex flex-row items-center gap-1.5">
              <ModeIcon mode="agent-full" />
              <span className="">Full Agent</span>
              <ToolTip
                style={{
                  zIndex: 200001,
                }}
                content="Full access mode, auto-approve all tools (完全权限)"
              >
                <InformationCircleIcon className="h-2.5 w-2.5 flex-shrink-0" />
              </ToolTip>
            </div>
            {!isGoodAtAgentMode && notGreatAtAgent("Full Agent")}
            <CheckIcon
              className={`ml-auto h-3 w-3 ${effectiveMode === "agent-full" ? "" : "opacity-0"}`}
            />
          </ListboxOption>

          <div className="text-description-muted px-2 py-1">
            {`${metaKeyLabel} . for next mode`}
          </div>
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
