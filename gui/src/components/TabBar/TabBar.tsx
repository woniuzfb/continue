import { XMarkIcon } from "@heroicons/react/24/outline";
import React, { useCallback, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import styled from "styled-components";
import { defaultBorderRadius } from "..";
import { AppDispatch, RootState } from "../../redux/store";
import {
  activateSessionTab,
  closeSessionTab,
  createAndActivateSession,
} from "../../redux/thunks/sessionActivation";
import { selectTabSummaries } from "../../redux/selectors/sessions";
import { retrySessionSave } from "../../redux/thunks/sessionPersistence";
import { varWithFallback } from "../../styles/theme";
import { selectActiveSessionId } from "../../redux/selectors/sessionView";

// Haven't set up theme colors for tabs yet
// Will keep it simple and choose from existing ones. Comments show vars we could use
const tabBorderVar = varWithFallback("border"); // --vscode-tab-border
const tabBackgroundVar = varWithFallback("background"); // --vscode-tab-inactiveBackground
const tabForegroundVar = varWithFallback("foreground"); // --vscode-tab-inactiveForeground
const tabHoverBackgroundVar = varWithFallback("list-hover"); // --vscode-tab-hoverBackground
const tabHoverForegroundVar = varWithFallback("foreground"); // --vscode-tab-hoverForeground
const tabSelectedBackgroundVar = varWithFallback("background"); // --vscode-tab-activeBackground
const tabSelectedForegroundVar = varWithFallback("foreground"); // --vscode-tab-activeForeground
const tabAccentVar = varWithFallback("accent"); // --vscode-tab-activeBorderTop

const TabBarContainer = styled.div`
  display: flex;
  flex-wrap: wrap;
  flex-shrink: 0;
  flex-grow: 0;
  background-color: ${tabBackgroundVar};
  border-bottom: none;
  position: relative;
  margin-top: 2px;
  max-height: 100px;
  overflow: auto;

  /* Hide scrollbar but keep functionality */
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
`;

const Tab = styled.div<{ isActive: boolean }>`
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 5px 0 12px;
  flex-grow: 1;
  width: 100px;
  max-width: 150px;
  height: 25px;
  background-color: ${(props) =>
    props.isActive ? tabSelectedBackgroundVar : tabBackgroundVar};
  color: ${(props) =>
    props.isActive ? tabSelectedForegroundVar : tabForegroundVar};
  cursor: pointer;
  border: 1px solid ${tabBorderVar};
  border-bottom: ${(props) =>
    props.isActive ? "none" : `1px solid ${tabBorderVar}`};
  user-select: none;
  position: relative;
  transition: background-color 0.2s;
  border-top: ${(props) =>
    props.isActive ? `1px solid ${tabAccentVar}` : `1px solid ${tabBorderVar}`};
  &:first-child {
    border-left: none;
  }
  & + & {
    border-left: none;
  }

  &:hover {
    background-color: ${(props) =>
      props.isActive ? tabSelectedBackgroundVar : tabHoverBackgroundVar};
    color: ${(props) =>
      props.isActive ? tabSelectedForegroundVar : tabHoverForegroundVar};
  }
`;

const TabTitle = styled.span`
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
`;

const CloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 4px;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  border-radius: ${defaultBorderRadius};
  padding: 2px;
  visibility: hidden;

  &:hover {
    opacity: 1;
    background-color: ${tabHoverBackgroundVar};
  }

  ${Tab}:hover & {
    visibility: visible;
  }

  &[disabled] {
    display: none !important;
  }
`;

const TabBarSpace = styled.div`
  flex: 1;
  display: flex;
  border-bottom: 1px solid ${tabBorderVar};
  background-color: ${tabBackgroundVar};
`;

export const TabBar = React.forwardRef<HTMLDivElement>((_, ref) => {
  const dispatch = useDispatch<AppDispatch>();
  const currentSessionId = useSelector((state: RootState) =>
    selectActiveSessionId(state),
  );
  // 方案.md §五.1: the tab bar is a projection of tabOrder + descriptors +
  // runtime, never its own state.
  const tabs = useSelector((state: RootState) => selectTabSummaries(state));

  const handleNewTab = useCallback(async () => {
    // 方案.md §五.18: the outgoing session is not part of creating a new one.
    await dispatch(createAndActivateSession({ origin: "new" }));
  }, [dispatch]);

  useEffect(() => {
    if (tabs.length === 0) {
      void handleNewTab();
    }
  }, [tabs.length, handleNewTab]);

  const handleTabClick = (sessionId: string) => {
    if (sessionId === currentSessionId) {
      return;
    }
    void dispatch(activateSessionTab({ sessionId }));
  };

  const handleTabClose = (sessionId: string) => {
    void dispatch(closeSessionTab({ sessionId }));
  };

  return (
    <TabBarContainer
      ref={ref}
      style={{
        display: tabs.length === 1 ? "none" : "flex",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.sessionId === currentSessionId;
        return (
          <Tab
            key={tab.sessionId}
            isActive={isActive}
            aria-current={isActive ? "page" : undefined}
            onClick={() => handleTabClick(tab.sessionId)}
            onAuxClick={(e) => {
              // Middle mouse button
              if (e.button === 1) {
                e.preventDefault();
                handleTabClose(tab.sessionId);
              }
            }}
          >
            <TabTitle>{tab.title}</TabTitle>
            {(tab.persistenceState === "failed" || tab.interrupted) && (
              <span
                title={
                  tab.persistenceState === "failed"
                    ? "Save failed - click to retry"
                    : "Turn interrupted - click to open"
                }
                className="text-error cursor-pointer px-1 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  if (tab.persistenceState === "failed") {
                    void dispatch(
                      retrySessionSave({ sessionId: tab.sessionId }),
                    );
                  } else {
                    handleTabClick(tab.sessionId);
                  }
                }}
              >
                !
              </span>
            )}
            <CloseButton
              /* disabled={tabs.length === 1} */
              onClick={(e) => {
                e.stopPropagation();
                handleTabClose(tab.sessionId);
              }}
            >
              <XMarkIcon width={12} height={12} />
            </CloseButton>
          </Tab>
        );
      })}
      <TabBarSpace>
        {/* <NewTabButton onClick={handleNewTab}>
          <PlusIcon width={16} height={16} />
        </NewTabButton> */}
      </TabBarSpace>
    </TabBarContainer>
  );
});
