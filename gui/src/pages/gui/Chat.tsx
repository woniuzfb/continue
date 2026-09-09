import {
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChatBubbleOvalLeftIcon,
} from "@heroicons/react/24/outline";
import { Editor, JSONContent } from "@tiptap/react";
import { ChatHistoryItem, InputModifiers } from "core";
import { renderChatMessage, stripImages } from "core/util/messageContent";
import { processEditorContent } from "../../components/mainInput/TipTapEditor/utils/processEditorContent";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErrorBoundary } from "react-error-boundary";
import styled from "styled-components";
import { Button, lightGray, vscBackground } from "../../components";
import { useFindWidget } from "../../components/find/FindWidget";
import TimelineItem from "../../components/gui/TimelineItem";
import { CopyIconButton } from "../../components/gui/CopyIconButton";
import HeaderButtonWithToolTip from "../../components/gui/HeaderButtonWithToolTip";
import { NewSessionButton } from "../../components/mainInput/belowMainInput/NewSessionButton";
import ThinkingBlockPeek from "../../components/mainInput/belowMainInput/ThinkingBlockPeek";
import ContinueInputBox from "../../components/mainInput/ContinueInputBox";
import { AttachmentMeta, AttachedFile } from "../../components/mainInput/types";
import { useOnboardingCard } from "../../components/OnboardingCard";
import StepContainer from "../../components/StepContainer";
import { TabBar } from "../../components/TabBar/TabBar";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  selectDoneApplyStates,
  selectPendingToolCalls,
} from "../../redux/selectors/selectToolCalls";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionHistory";
import { streamEditThunk } from "../../redux/thunks/edit";
import { createAndActivateSession } from "../../redux/thunks/sessionActivation";
import { bootstrapLastSession } from "../../redux/thunks/sessionLifecycle";
import { loadMoreHistory as loadMoreHistoryThunk } from "../../redux/thunks/sessionPaging";
import {
  approveActiveToolCall,
  rejectActiveToolCall,
} from "../../redux/thunks/sessionTools";
import { submitSessionInput } from "../../redux/thunks/sessionSubmit";
import { isJetBrains, isMetaEquivalentKeyPressed } from "../../util";
import { ToolCallDiv } from "./ToolCallDiv";
import {
  applySessionToolCallUpdate,
  findSessionToolCallTarget,
} from "../../redux/util/sessionToolCallWrites";

import { useStore } from "react-redux";
import FeedbackDialog from "../../components/dialogs/FeedbackDialog";

import { FatalErrorIndicator } from "../../components/config/FatalErrorNotice";
import { DeprecationBanner } from "../../components/DeprecationBanner";
import InlineErrorMessage from "../../components/mainInput/InlineErrorMessage";
import SessionSaveErrorBanner from "../../components/mainInput/SessionSaveErrorBanner";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { RootState } from "../../redux/store";
import { stopActiveSessionStream } from "../../redux/thunks/sessionStreams";
import { getLocalStorage, setLocalStorage } from "../../util/localStorage";
import { EmptyChatBody } from "./EmptyChatBody";
import { ExploreDialogWatcher } from "./ExploreDialogWatcher";
import { useAutoScroll } from "./useAutoScroll";

import {
  selectActiveCodeToEdit,
  selectActiveHasMoreHistory,
  selectActiveHistory,
  selectActiveIsHistoryLoading,
  selectActiveIsInEdit,
  selectActiveIsStreaming,
  selectActiveMode,
  selectActiveSessionId,
  selectLastSessionId,
} from "../../redux/selectors/sessionView";

// Helper function to find the index of the latest conversation summary
function findLatestSummaryIndex(history: ChatHistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].conversationSummary) {
      return i;
    }
  }
  return -1; // No summary found
}

const StepsDiv = styled.div`
  position: relative;
  background-color: transparent;
  min-width: 0;

  & > * {
    position: relative;
    min-width: 0;
  }

  .thread-message {
    margin: 0 0 0 1px;
    min-width: 0;
  }
`;

export const MAIN_EDITOR_INPUT_ID = "main-editor-input";

function fallbackRender({ error, resetErrorBoundary }: any) {
  // Call resetErrorBoundary() to reset the error boundary and retry the render.

  return (
    <div
      role="alert"
      className="px-2"
      style={{ backgroundColor: vscBackground }}
    >
      <p>Something went wrong:</p>
      <pre style={{ color: "red" }}>{error.message}</pre>
      <pre style={{ color: lightGray }}>{error.stack}</pre>

      <div className="text-center">
        <Button onClick={resetErrorBoundary}>Restart</Button>
      </div>
    </div>
  );
}

export function Chat() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const reduxStore = useStore<RootState>();
  const onboardingCard = useOnboardingCard();
  const showSessionTabs = useAppSelector(
    (store) => store.config.config.ui?.showSessionTabs,
  );
  const isStreaming = useAppSelector((state) => selectActiveIsStreaming(state));
  const sessionId = useAppSelector((state) => selectActiveSessionId(state));
  const [stepsOpen] = useState<(boolean | undefined)[]>([]);
  const mainTextInputRef = useRef<HTMLInputElement>(null);
  const stepsDivRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // Set while the "jump to previous message" button is loading earlier
  // history and scrolling, so useAutoScroll does not yank the view to the
  // bottom in the middle of the jump.
  const jumpSuppressRef = useRef(false);
  // Increments on every jump; a stale jump's timeout must not release the
  // suppression while a newer jump is still in flight.
  const jumpTokenRef = useRef(0);
  const history = useAppSelector((state) => selectActiveHistory(state));
  const isHistoryLoading = useAppSelector((state) =>
    selectActiveIsHistoryLoading(state),
  );
  const showChatScrollbar = useAppSelector(
    (state) => state.config.config.ui?.showChatScrollbar,
  );
  const codeToEdit = useAppSelector((state) => selectActiveCodeToEdit(state));
  const isInEdit = useAppSelector((store) => selectActiveIsInEdit(store));

  const lastSessionId = useAppSelector((state) => selectLastSessionId(state));
  const hasDismissedExploreDialog = useAppSelector(
    (state) => state.ui.hasDismissedExploreDialog,
  );
  const jetbrains = useMemo(() => {
    return isJetBrains();
  }, []);

  useAutoScroll(stepsDivRef, history, sessionId, jumpSuppressRef);

  useEffect(() => {
    // Cmd + Backspace to delete current step
    const listener = (e: KeyboardEvent) => {
      if (
        e.key === "Backspace" &&
        (jetbrains ? e.altKey : isMetaEquivalentKeyPressed(e)) &&
        !e.shiftKey
      ) {
        void dispatch(stopActiveSessionStream());
      }
    };
    window.addEventListener("keydown", listener);

    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [isStreaming, jetbrains, isInEdit]);

  const { widget, highlights } = useFindWidget(
    stepsDivRef,
    tabsRef,
    isStreaming,
  );

  const sendInput = useCallback(
    async (
      editorState: JSONContent,
      modifiers: InputModifiers,
      index?: number,
      editorToClearOnSend?: Editor,
      attachments?: AttachedFile[],
    ): Promise<boolean> => {
      const stateSnapshot = reduxStore.getState();
      const latestPendingToolCalls = selectPendingToolCalls(stateSnapshot);
      const latestPendingApplyStates = selectDoneApplyStates(stateSnapshot);
      const isCurrentlyInEdit = selectActiveIsInEdit(stateSnapshot);
      const codeToEditSnapshot = selectActiveCodeToEdit(stateSnapshot);
      const selectedModelByRole =
        stateSnapshot.config.config.selectedModelByRole;
      const currentMode = selectActiveMode(stateSnapshot);

      // Cancel all pending tool calls
      latestPendingToolCalls.forEach((toolCallState) => {
        void dispatch(
          rejectActiveToolCall({ toolCallId: toolCallState.toolCallId }),
        );
      });

      // Reject all pending apply states
      latestPendingApplyStates.forEach((applyState) => {
        if (applyState.status !== "closed") {
          ideMessenger.post("rejectDiff", applyState);
        }
      });
      const model = isCurrentlyInEdit
        ? (selectedModelByRole.edit ?? selectedModelByRole.chat)
        : selectedModelByRole.chat;

      if (!model) {
        return false;
      }

      if (isCurrentlyInEdit && codeToEditSnapshot.length === 0) {
        return false;
      }

      if (isCurrentlyInEdit) {
        return await dispatch(
          streamEditThunk({
            editorState,
            codeToEdit: codeToEditSnapshot,
          }),
        ).unwrap();
      } else {
        const sendPromise = dispatch(
          submitSessionInput({
            sessionId: selectActiveSessionId(reduxStore.getState()),
            editorState,
            modifiers,
            index,
            attachments,
          }),
        );

        // Clear the editor immediately (optimistically), same as before the
        // send-success reporting was introduced. Only the await below (used to
        // decide whether to restore attached files on failure) waits for the
        // stream to finish.
        if (editorToClearOnSend) {
          editorToClearOnSend.commands.clearContent();
        }

        // Increment localstorage counter for popup
        const currentCount = getLocalStorage("mainTextEntryCounter");
        if (currentCount) {
          setLocalStorage("mainTextEntryCounter", currentCount + 1);
          if (currentCount === 300) {
            dispatch(setDialogMessage(<FeedbackDialog />));
            dispatch(setShowDialog(true));
          }
        } else {
          setLocalStorage("mainTextEntryCounter", 1);
        }

        return await sendPromise.unwrap();
      }
    },
    [dispatch, ideMessenger, reduxStore],
  );

  useWebviewListener(
    "newSession",
    async () => {
      // unwrapResult(response) // errors if session creation failed
      mainTextInputRef.current?.focus?.();
    },
    [mainTextInputRef],
  );

  // Handle partial tool call output for streaming updates
  useWebviewListener(
    "toolCallPartialOutput",
    async (data) => {
      // Update tool call output in Redux store
      const state = reduxStore.getState();
      const targetSessionId = selectActiveSessionId(state);
      const target = targetSessionId
        ? findSessionToolCallTarget(
            state.sessions.sessionsById[targetSessionId]?.history ?? [],
            data.toolCallId,
          )
        : undefined;
      if (targetSessionId && target) {
        applySessionToolCallUpdate(
          { dispatch, getState: reduxStore.getState },
          {
            sessionId: targetSessionId,
            messageId: target.assistantItem.message.id,
            toolCallId: data.toolCallId,
            patch: { output: data.contextItems },
          },
        );
      }
    },
    [dispatch],
  );

  const isLastUserInput = useCallback(
    (index: number): boolean => {
      return !history
        .slice(index + 1)
        .some((entry) => entry.message.role === "user");
    },
    [history],
  );

  /**
   * Scrolls to the next user message. Messages below the current one are
   * always already loaded (lazy loading only truncates the head), so no
   * history loading is needed here. When there is no next user message,
   * pulls the chat to the very bottom (latest content) instead.
   */
  const jumpToNextUserMessage = useCallback(
    (currentMessageId: string) => {
      const h = selectActiveHistory(reduxStore.getState());
      const idx = h.findIndex((item) => item.message.id === currentMessageId);
      if (idx < 0) {
        // Stale message id (history was replaced): nothing to jump to.
        return;
      }
      let target: string | undefined;
      for (let i = idx + 1; i < h.length; i++) {
        if (h[i].message.role === "user") {
          target = h[i].message.id;
          break;
        }
      }
      if (!target) {
        // No next user message: pull to the very bottom (latest content).
        stepsDivRef.current?.scrollTo({
          top: stepsDivRef.current.scrollHeight,
          behavior: "smooth",
        });
        return;
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-message-id="${target}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
    },
    [reduxStore, stepsDivRef],
  );

  /**
   * Scrolls to the previous user message. With lazy-loaded history, older
   * messages may not be in the DOM yet; load pages of earlier history
   * (loadMoreHistory) until the target message exists, then scroll.
   */
  const jumpToPreviousUserMessage = useCallback(
    async (currentMessageId: string) => {
      // Suppress useAutoScroll's auto-bottom while we load earlier pages and
      // scroll; otherwise the prepend (new user messages in loaded history)
      // resets the scroll state and yanks the view to the bottom.
      jumpSuppressRef.current = true;
      const myToken = ++jumpTokenRef.current;
      try {
        // Stale message id (history was replaced): never load pages just to
        // jump; abort instead.
        if (
          !selectActiveHistory(reduxStore.getState()).some(
            (item) => item.message.id === currentMessageId,
          )
        ) {
          return;
        }
        // Always read the freshest history: prepends shift indices, so the
        // current message's position must be recomputed on every call.
        const findTarget = (): string | undefined => {
          const h = selectActiveHistory(reduxStore.getState());
          const idx = h.findIndex(
            (item) => item.message.id === currentMessageId,
          );
          for (let i = idx - 1; i >= 0; i--) {
            if (h[i].message.role === "user") {
              return h[i].message.id;
            }
          }
          return undefined;
        };

        let target = findTarget();
        let prevLength = selectActiveHistory(reduxStore.getState()).length;
        // Load pages of earlier history until the target shows up. Guarded by
        // hasMoreHistory / isHistoryLoading; stops if a load makes no progress
        // (failure or empty page) so it can never spin forever.
        while (!target) {
          const state = reduxStore.getState();
          if (selectActiveIsHistoryLoading(state)) {
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          if (!selectActiveHasMoreHistory(state)) {
            break;
          }
          await dispatch(
            loadMoreHistoryThunk({
              sessionId: selectActiveSessionId(state),
              requestGeneration:
                state.sessions.sessionsById[selectActiveSessionId(state)]
                  ?.pagination.requestGeneration ?? 0,
            }),
          );
          target = findTarget();
          const len = selectActiveHistory(reduxStore.getState()).length;
          if (len === prevLength) {
            break;
          }
          prevLength = len;
        }
        if (!target) {
          return;
        }
        // Wait for React to commit the (possibly just-loaded) messages before
        // scrolling.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document
              .querySelector(`[data-message-id="${target}"]`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        });
      } finally {
        // Release the suppression only once the (smooth) scroll has settled.
        // A fixed timeout can fire mid-scroll: while the view passes the top
        // region (scrollTop < 50), useAutoScroll's top-detection would then
        // trigger an unwanted lazy load. Token guard: a newer jump owns the
        // suppression until it settles.
        let lastTop = -1;
        const checkSettled = () => {
          if (jumpTokenRef.current !== myToken) {
            return;
          }
          const el = stepsDivRef.current;
          if (!el) {
            jumpSuppressRef.current = false;
            return;
          }
          if (el.scrollTop === lastTop) {
            jumpSuppressRef.current = false;
            return;
          }
          lastTop = el.scrollTop;
          requestAnimationFrame(checkSettled);
        };
        requestAnimationFrame(checkSettled);
      }
    },
    [dispatch, reduxStore, jumpSuppressRef, jumpTokenRef],
  );

  const renderChatHistoryItem = useCallback(
    (item: ChatHistoryItemWithMessageId, index: number) => {
      const {
        message,
        editorState,
        contextItems,
        appliedRules,
        toolCallStates,
      } = item;

      // Attached files are persisted on message.metadata (written at send
      // time in streamResponseThunk) so already-sent user messages can render
      // file chips without the file content leaking into editorState.
      const attachments =
        (message.metadata?.attachments as AttachmentMeta[] | undefined) ?? [];

      // Calculate once for the entire function
      const latestSummaryIndex = findLatestSummaryIndex(history);
      const isBeforeLatestSummary =
        latestSummaryIndex !== -1 && index < latestSummaryIndex;

      if (message.role === "user") {
        return (
          <ContinueInputBox
            onEnter={(editorState, modifiers) =>
              sendInput(editorState, modifiers, index)
            }
            attachments={attachments}
            isLastUserInput={isLastUserInput(index)}
            isMainInput={false}
            editorState={editorState ?? item.message.content}
            contextItems={contextItems}
            appliedRules={appliedRules}
            inputId={message.id}
            bottomRightActions={
              <>
                <CopyIconButton
                  text={() => {
                    // Copy the user's typed text only: strip everything from
                    // the synthetic "Files attached by the user:" marker on
                    // (the attachment <file_content> blocks) so the clipboard
                    // doesn't get the attachment payload. trimEnd (not trim)
                    // so a fully-indented message keeps its first-line indent.
                    //
                    // Prefer text re-derived from editorState: it is the same
                    // source the bubble renders (pre-wrap), so the clipboard
                    // matches the bubble exactly, including indentation, and
                    // it also repairs older messages whose message.content was
                    // persisted after per-paragraph trimStart stripped the
                    // indentation. Slash-command messages fall back to
                    // message.content since their content holds the resolved
                    // prompt, not the raw typed text.
                    const hasPromptBlock =
                      editorState?.content?.some(
                        (p: JSONContent) => p.type === "prompt-block",
                      ) ?? false;
                    const text =
                      editorState && !hasPromptBlock
                        ? stripImages(processEditorContent(editorState).parts)
                        : renderChatMessage(message);
                    const marker = text.indexOf(
                      "\n\nFiles attached by the user:",
                    );
                    return (
                      marker >= 0 ? text.slice(0, marker) : text
                    ).trimEnd();
                  }}
                  clipboardIconClassName="h-3.5 w-3.5 text-gray-400"
                  checkIconClassName="h-3.5 w-3.5 text-green-400"
                  tooltipPlacement="top"
                />
                <HeaderButtonWithToolTip
                  text="Go to previous message"
                  tooltipPlacement="top"
                  onClick={() => jumpToPreviousUserMessage(message.id)}
                >
                  <ArrowUpIcon className="h-3.5 w-3.5 text-gray-400" />
                </HeaderButtonWithToolTip>
                <HeaderButtonWithToolTip
                  text="Go to next message"
                  tooltipPlacement="top"
                  onClick={() => jumpToNextUserMessage(message.id)}
                >
                  <ArrowDownIcon className="h-3.5 w-3.5 text-gray-400" />
                </HeaderButtonWithToolTip>
              </>
            }
          />
        );
      }

      if (message.role === "tool") {
        return null;
      }

      if (message.role === "assistant") {
        return (
          <>
            {/* Always render assistant content through normal path */}
            <div className="thread-message">
              <TimelineItem
                item={item}
                iconElement={
                  <ChatBubbleOvalLeftIcon width="16px" height="16px" />
                }
                open={
                  typeof stepsOpen[index] === "undefined"
                    ? true
                    : stepsOpen[index]!
                }
                onToggle={() => {}}
              >
                <StepContainer
                  index={index}
                  isLast={index === history.length - 1}
                  item={item}
                  latestSummaryIndex={latestSummaryIndex}
                />
              </TimelineItem>
            </div>

            {toolCallStates && (
              <ToolCallDiv
                toolCallStates={toolCallStates}
                historyIndex={index}
              />
            )}
          </>
        );
      }

      if (message.role === "thinking") {
        const thinkingContent = renderChatMessage(message);
        if (!thinkingContent?.trim()) {
          return null;
        }
        return (
          <div className={isBeforeLatestSummary ? "opacity-50" : ""}>
            <ThinkingBlockPeek
              content={thinkingContent}
              redactedThinking={message.redactedThinking}
              index={index}
              prevItem={index > 0 ? history[index - 1] : null}
              inProgress={index === history.length - 1 && isStreaming}
              signature={message.signature}
            />
            {index === history.length - 1 && !isStreaming && (
              <StepContainer
                actionsOnly
                index={index}
                isLast={true}
                item={item}
                latestSummaryIndex={latestSummaryIndex}
              />
            )}
          </div>
        );
      }

      // Default case - regular assistant message
      return (
        <div className="thread-message">
          <TimelineItem
            item={item}
            iconElement={<ChatBubbleOvalLeftIcon width="16px" height="16px" />}
            open={
              typeof stepsOpen[index] === "undefined" ? true : stepsOpen[index]!
            }
            onToggle={() => {}}
          >
            <StepContainer
              index={index}
              isLast={index === history.length - 1}
              item={item}
              latestSummaryIndex={latestSummaryIndex}
            />
          </TimelineItem>
        </div>
      );
    },
    [
      sendInput,
      isLastUserInput,
      history,
      stepsOpen,
      isStreaming,
      jumpToPreviousUserMessage,
      jumpToNextUserMessage,
    ],
  );

  const showScrollbar = showChatScrollbar ?? window.innerHeight > 5000;

  return (
    <>
      {!!showSessionTabs && !isInEdit && <TabBar ref={tabsRef} />}
      {widget}

      <StepsDiv
        ref={stepsDivRef}
        className={`w-full pt-[8px] ${showScrollbar ? "thin-scrollbar" : "no-scrollbar"} ${history.length > 0 ? "min-h-0 flex-1 overflow-y-scroll" : "shrink-0"}`}
      >
        <DeprecationBanner dismissable={true} />
        {highlights}
        {isHistoryLoading && (
          <div className="flex justify-center py-2">
            <div className="text-description animate-pulse text-xs">
              加载更早的消息…
            </div>
          </div>
        )}
        {history
          .filter((item) => item.message.role !== "system")
          .map((item, index: number) => (
            <div
              key={item.message.id}
              data-message-id={item.message.id}
              className="min-w-0"
              style={{
                minHeight: index === history.length - 1 ? "200px" : 0,
              }}
            >
              <ErrorBoundary
                FallbackComponent={fallbackRender}
                onReset={() => {
                  void dispatch(createAndActivateSession({ origin: "new" }));
                }}
              >
                {renderChatHistoryItem(item, index)}
              </ErrorBoundary>
              {index === history.length - 1 && <InlineErrorMessage />}
            </div>
          ))}
      </StepsDiv>
      <div className={"relative shrink-0"}>
        <SessionSaveErrorBanner />
        <ContinueInputBox
          isMainInput
          isLastUserInput={false}
          onEnter={(editorState, modifiers, editor, attachments) =>
            sendInput(editorState, modifiers, undefined, editor, attachments)
          }
          inputId={MAIN_EDITOR_INPUT_ID}
        />

        <div
          style={{
            pointerEvents: isStreaming ? "none" : "auto",
          }}
        >
          <div className="flex flex-row items-center justify-between pb-1 pl-0.5 pr-2">
            <div className="xs:inline hidden">
              {history.length === 0 && lastSessionId && !isInEdit && (
                <NewSessionButton
                  onClick={async () => {
                    await dispatch(bootstrapLastSession());
                  }}
                  className="flex items-center gap-2"
                >
                  <ArrowLeftIcon className="h-3 w-3" />
                  <span className="text-xs">Last Session</span>
                </NewSessionButton>
              )}
            </div>
          </div>
          <FatalErrorIndicator />
          {!hasDismissedExploreDialog && <ExploreDialogWatcher />}
          {history.length === 0 && (
            <EmptyChatBody showOnboardingCard={onboardingCard.show} />
          )}
        </div>
      </div>
    </>
  );
}
