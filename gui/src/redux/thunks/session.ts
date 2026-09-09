import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { BaseSessionMetadata, ChatMessage, Session } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import {
  renderChatMessage,
  replaceFileContentBlocks,
} from "core/util/messageContent";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { selectSelectedChatModel } from "../slices/configSlice";
import { selectSelectedProfile } from "../slices/profilesSlice";
import {
  clearContextMetrics,
  deleteSessionMetadata,
  markSessionDirty,
  markSessionPersisted,
  newSession,
  setAllSessionMetadata,
  setHistoryPagination,
  setIsSessionMetadataLoading,
  updateSessionMetadata,
} from "../slices/sessionSlice";
import { RootState, ThunkApiType } from "../store";
import { updateSelectedModelByRole } from "../thunks/updateSelectedModelByRole";
import { compileChatForContextMetrics } from "./compileChatForContextMetrics";
import { constructMessages } from "../util/constructMessages";
import { createAndActivateSession } from "./sessionActivation";
import {
  bootstrapLastSession,
  deleteSessionRuntime,
  openSessionTab,
} from "./sessionLifecycle";
import { enqueueSessionSave, flushSessionSave } from "./sessionPersistence";

const MAX_TITLE_LENGTH = 100;

// Async session functions live in thunks (because of IDE messaging mostly)
// see sessionSlice for sync redux session functions

export async function getSession(
  ideMessenger: IIdeMessenger,
  id: string,
): Promise<Session> {
  const result = await ideMessenger.request("history/load", { id });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.content;
}

/**
 * 分页加载会话：只读取最近 N 条消息，并返回分页元数据 + session 元数据。
 * 当 lazyLoadHistory 开启时使用。单次 IPC 调用，避免重复读盘。
 */
export async function getSessionPage(
  ideMessenger: IIdeMessenger,
  id: string,
  limit: number,
): Promise<{
  session: Session;
  hasMore: boolean;
  totalCount: number;
  loadedOffset: number;
}> {
  // loadPage 一次性返回 history 切片 + session 元数据（title/mode/.../contextMetrics）
  const res = await ideMessenger.request("history/loadPage", {
    id,
    offset: 0,
    limit,
  });
  if (res.status === "error") {
    throw new Error(res.error);
  }
  const { items, hasMore, total, session: meta } = res.content;
  const loadedOffset = total - items.length; // 头部未加载条数
  const session: Session = {
    sessionId: id,
    title: meta.title,
    workspaceDirectory: meta.workspaceDirectory,
    history: items,
    mode: meta.mode,
    chatModelTitle: meta.chatModelTitle,
    contextMetrics: meta.contextMetrics,
  };
  return {
    session,
    hasMore,
    totalCount: total,
    loadedOffset,
  };
}

export const refreshSessionMetadata = createAsyncThunk<
  BaseSessionMetadata[],
  {
    offset?: number;
    limit?: number;
  },
  ThunkApiType
>("session/refreshMetadata", async ({ offset, limit }, { dispatch, extra }) => {
  const result = await extra.ideMessenger.request("history/list", {
    limit,
    offset,
  });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  dispatch(setIsSessionMetadataLoading(false));
  dispatch(setAllSessionMetadata(result.content));
  return result.content;
});

export const deleteSession = createAsyncThunk<void, string, ThunkApiType>(
  "session/delete",
  async (id, { dispatch }) => {
    // Phase 4 handoff: stop own stream, release runtime, delete on disk and
    // activate the neighbour (方案.md §五.19).
    await dispatch(deleteSessionRuntime({ sessionId: id })).unwrap();
  },
);

export const updateSession = createAsyncThunk<void, Session, ThunkApiType>(
  "session/update",
  async (session, { extra, dispatch }) => {
    dispatch(
      updateSessionMetadata({
        sessionId: session.sessionId,
        title: session.title,
      }),
    ); // optimistic session metadata update
    const result = await extra.ideMessenger.request("history/save", session);
    if (result.status === "error") {
      throw new Error(result.error);
    }
    await dispatch(refreshSessionMetadata({}));
  },
);

/**
 * 保存“后台续流”的会话：流所属会话已在流期间被切走，此时
 * getState().session 是别的会话，完整内容在 LRU 缓存副本里。
 * 标题逻辑与 saveCurrentSession 保持一致（LLM 生成 + 文本回退）。
 */
export const loadSession = createAsyncThunk<
  void,
  { sessionId: string; saveCurrentSession: boolean },
  ThunkApiType
>(
  "session/load",
  async ({ sessionId, saveCurrentSession }, { dispatch, getState }) => {
    // Phase 4 handoff: activation + hydration live in sessionActivation /
    // sessionLifecycle. Saving the outgoing session is the caller's boundary.
    if (saveCurrentSession) {
      const activeSessionId = getState().sessions.activeSessionId;
      if (activeSessionId && activeSessionId !== sessionId) {
        void dispatch(
          enqueueSessionSave({
            sessionId: activeSessionId,
            reason: "TAB_SWITCH",
          }),
        );
      }
    }
    await dispatch(openSessionTab({ sessionId })).unwrap();
  },
);

export const selectChatModelForProfile = createAsyncThunk<
  void,
  string,
  ThunkApiType
>(
  "session/selectModelForCurrentProfile",
  async (modelTitle, { extra, dispatch, getState }) => {
    const state = getState();
    const modelMatch = state.config.config?.modelsByRole?.chat?.find(
      (m) => m.title === modelTitle,
    );
    const selectedProfile = selectSelectedProfile(state);
    if (selectedProfile && modelMatch) {
      const previousModelTitle = selectSelectedChatModel(state)?.title;
      await dispatch(
        updateSelectedModelByRole({
          role: "chat",
          modelTitle: modelTitle,
          selectedProfile,
        }),
      );
      // chatModelTitle is persisted with the session rather than the profile.
      // A model switch without a subsequent message must therefore make the
      // current session eligible for the next tab-switch save.
      if (previousModelTitle !== modelTitle) {
        dispatch(markSessionDirty());
      }
    }
  },
);

export const loadLastSession = createAsyncThunk<
  void,
  { skipCachingCurrent?: string } | void,
  ThunkApiType
>("session/loadLast", async (_arg, { dispatch }) => {
  // Phase 4 handoff: the session-scoped lifecycle owns startup now. The name is
  // kept until every call site is renamed (方案.md §九).
  await dispatch(bootstrapLastSession()).unwrap();
});

/**
 * 取第一个含非空正文的回复 run 的完整文本作为标题生成输入。
 * 一轮回复可能被 thinking 气泡拆成多个 assistant history item
 * （dontMergeReplyBubbles 默认 true），只取第一条会丢失句中续流内容。
 * 拼接语义与复制按钮（ResponseActions）和重载合并（mergeSplitReplies）
 * 保持一致：run = 连续的 assistant/thinking 条目（user/tool/system 打断），
 * 正文 join("")（续流是句中续接，不是独立段落）；跨 run 不聚合。
 * content 为 parts 数组时用 renderChatMessage 取纯文本（toString 会得到
 * "[object Object]"）。
 */
export function getAssistantResponseText(
  history: { message: ChatMessage }[] | undefined,
): string | undefined {
  const parts: string[] = [];
  for (const item of history ?? []) {
    const role = item.message.role;
    if (role === "assistant" || role === "thinking") {
      if (role === "assistant") {
        const text = renderChatMessage(item.message);
        if (text.trim().length > 0) {
          parts.push(text);
        }
      }
    } else if (parts.length > 0) {
      break; // 第一个非空 run 结束，不再跨 run 聚合
    }
  }
  return parts.length ? parts.join("") : undefined;
}

export function getChatTitleFromMessage(message: ChatMessage) {
  // Replace <file_content>...</file_content> attachment blocks with a
  // [file: path] marker BEFORE picking the last line. Without this, a session
  // whose first message attaches files would get a title of "</file_content>"
  // (the last non-empty line of the raw attachment block).
  const lines = replaceFileContentBlocks(renderChatMessage(message))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

  // Skip the attachment boilerplate and file markers; if the message was ONLY
  // a file attachment, fall back to the file marker itself so the title is
  // still meaningful.
  const textLines = lines.filter(
    (l) => l !== "Files attached by the user:" && !l.startsWith("[file:"),
  );
  const text = textLines.at(-1) ?? lines.at(-1) ?? "";

  // Truncate
  if (text.length > MAX_TITLE_LENGTH) {
    return text.slice(0, MAX_TITLE_LENGTH - 3) + "...";
  }
  return text;
}

export const saveCurrentSession = createAsyncThunk<
  void,
  { openNewSession: boolean },
  ThunkApiType
>("session/saveCurrent", async ({ openNewSession }, { dispatch, getState }) => {
  // The runtime in sessionsById[sessionId] is the only save snapshot
  // (方案.md §六 sessionPersistence).
  const sessionId = getState().sessions.activeSessionId;
  const runtime = sessionId
    ? getState().sessions.sessionsById[sessionId]
    : undefined;
  if (
    sessionId &&
    runtime &&
    runtime.history.length > 0 &&
    (runtime.dirty || runtime.title === NEW_SESSION_TITLE)
  ) {
    await dispatch(flushSessionSave({ sessionId }));
  }
  if (openNewSession) {
    await dispatch(createAndActivateSession({ origin: "new" }));
  }
});
