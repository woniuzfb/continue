import { XMarkIcon } from "@heroicons/react/24/outline";
import React, { useCallback, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import styled from "styled-components";
import { defaultBorderRadius } from "..";
import { newSession } from "../../redux/slices/sessionSlice";
import {
  addTab,
  handleSessionChange,
  removeTab,
  setActiveTab,
  setPendingSessionAction,
  setTabs,
} from "../../redux/slices/tabsSlice";
import { AppDispatch, RootState } from "../../redux/store";
import { loadSession, saveCurrentSession } from "../../redux/thunks/session";
import { varWithFallback } from "../../styles/theme";

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
  const currentSessionId = useSelector((state: RootState) => state.session.id);
  const currentSessionTitle = useSelector(
    (state: RootState) => state.session.title,
  );
  const hasHistory = useSelector(
    (state: RootState) => state.session.history.length > 0,
  );
  const isStreaming = useSelector(
    (state: RootState) => state.session.isStreaming,
  );
  const tabs = useSelector((state: RootState) => state.tabs.tabs);

  // Simple UUID generator for our needs
  const generateId = useCallback(() => {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  }, []);

  useEffect(() => {
    if (!currentSessionId) return;

    dispatch(
      handleSessionChange({
        currentSessionId,
        currentSessionTitle,
        newTabId: generateId(), // Pass the ID generator result
      }),
    );
  }, [currentSessionId, currentSessionTitle]);

  const handleNewTab = async () => {
    // 必须在 dispatch(newSession()) 之前发起 save：saveCurrentSession 内部第一行
    // 同步读取 getState().session，newSession 后会读到空 history 而跳过保存。
    // 用 void fire-and-forget：同步部分（getState、find、updateSessionMetadata）
    // 微秒级完成，异步部分（IPC、LLM 标题生成）在后台执行不阻塞 UI。
    // 流式响应进行中时跳过 save（避免把半成品写到磁盘），并把 newSession 延迟
    // 到流结束后执行，避免切换/新建会话中断当前响应。
    if (hasHistory && !isStreaming) {
      void dispatch(
        saveCurrentSession({
          openNewSession: false,
        }),
      );
    }

    if (isStreaming) {
      dispatch(setPendingSessionAction({ type: "new" }));
    } else {
      dispatch(newSession());
    }

    dispatch(
      addTab({
        id: generateId(),
        title: `Chat ${tabs.length + 1}`,
        isActive: true,
        sessionId: undefined,
      }),
    );
  };

  useEffect(() => {
    if (!tabs.length) {
      handleNewTab();
    }
  }, [tabs.map((t) => t.id).join(",")]);

  const handleTabClick = async (id: string) => {
    const targetTab = tabs.find((tab) => tab.id === id);
    if (!targetTab) return;

    // 先切 UI（立即响应），save/load 在后台执行。
    // 旧实现 await loadSession 阻塞 setActiveTab，目标 session 未命中 LRU
    // 缓存时（如 new session tab）需等 IPC + compileChatForContextMetrics
    // 完成才能看到 tab 切换，造成明显卡顿。
    const shouldSave = hasHistory;
    dispatch(setActiveTab(id));

    // 空 tab（尚未绑定 session）或当前 tab：没有会话需要切换，直接返回，
    // 不影响进行中的流式响应。
    if (!targetTab.sessionId || targetTab.sessionId === currentSessionId) {
      return;
    }

    if (isStreaming) {
      // 流式响应进行中：记录待切换的会话，等流结束后再加载，
      // 避免切 tab 中断当前响应。
      dispatch(
        setPendingSessionAction({
          type: "load",
          sessionId: targetTab.sessionId,
          saveCurrentSession: shouldSave,
        }),
      );
      return;
    }

    void dispatch(
      loadSession({
        sessionId: targetTab.sessionId,
        saveCurrentSession: shouldSave,
      }),
    );
  };

  const handleTabClose = async (id: string) => {
    //if (tabs.length <= 1) return;

    const isClosingActive = tabs.find((t) => t.id === id)?.isActive;
    const filtered = tabs.filter((t) => t.id !== id);

    if (isClosingActive) {
      const lastTab = filtered[filtered.length - 1];
      if (filtered.length) {
        await handleTabClick(lastTab.id);
        dispatch(
          setTabs(
            filtered.map((tab, i) => ({
              ...tab,
              isActive: i === filtered.length - 1,
            })),
          ),
        );
      } else {
        dispatch(setTabs([]));
        dispatch(newSession());
      }
    } else {
      dispatch(removeTab(id));
    }
  };

  return (
    <TabBarContainer
      ref={ref}
      style={{
        display: tabs.length === 1 ? "none" : "flex",
      }}
    >
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          isActive={tab.isActive}
          onClick={() => handleTabClick(tab.id)}
          onAuxClick={(e) => {
            // Middle mouse button
            if (e.button === 1) {
              e.preventDefault();
              handleTabClose(tab.id);
            }
          }}
        >
          <TabTitle>{tab.title}</TabTitle>
          <CloseButton
            /* disabled={tabs.length === 1} */
            onClick={(e) => {
              e.stopPropagation();
              handleTabClose(tab.id);
            }}
          >
            <XMarkIcon width={12} height={12} />
          </CloseButton>
        </Tab>
      ))}
      <TabBarSpace>
        {/* <NewTabButton onClick={handleNewTab}>
          <PlusIcon width={16} height={16} />
        </NewTabButton> */}
      </TabBarSpace>
    </TabBarContainer>
  );
});
