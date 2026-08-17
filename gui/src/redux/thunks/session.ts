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
  deleteCachedSession,
  deleteSessionMetadata,
  getCachedSession,
  markSessionDirty,
  markSessionPersisted,
  newSession,
  restoreCachedSession,
  setAllSessionMetadata,
  setCachedSession,
  setHistoryPagination,
  setIsSessionMetadataLoading,
  updateSessionMetadata,
} from "../slices/sessionSlice";
import { RootState, ThunkApiType } from "../store";
import { updateSelectedModelByRole } from "../thunks/updateSelectedModelByRole";
import { compileChatForContextMetrics } from "./compileChatForContextMetrics";
import { constructMessages } from "../util/constructMessages";

const MAX_TITLE_LENGTH = 100;

/**
 * Snapshots the current session state into the LRU cache.
 * Called before switching to / creating a new session so that switching back
 * restores the in-memory state (including lazily-loaded full history) without
 * re-reading from disk.
 */
export function cacheCurrentSession(state: RootState): void {
  const session = state.session;
  if (!session.id) {
    return;
  }
  // 空 session 也缓存：让 new session tab 切回时命中 LRU 走同步路径，
  // 避免对不存在的 session id 做 IPC 往返（loadPage → 文件不存在 → 返回空）。
  // 伪空 session（redux-persist 恢复的 {id:A, history:[]}，磁盘有历史）
  // 不会进入缓存：它只在重启后出现，而启动时 loadSession 的
  // sessionId===state.session.id 分支会跳过 cacheCurrentSession。
  const selectedChatModel = selectSelectedChatModel(state);
  setCachedSession(session.id, {
    sessionId: session.id,
    title: session.title,
    history: session.history,
    mode: session.mode,
    chatModelTitle: selectedChatModel?.title,
    hasReasoningEnabled: session.hasReasoningEnabled,
    isStreaming: session.isStreaming,
    dirty: session.dirty,
    historyTruncated: session.historyTruncated,
    historyLoadedOffset: session.historyLoadedOffset,
    historyTotalCount: session.historyTotalCount,
    hasMoreHistory: session.hasMoreHistory,
    loadedDiskCount: session.loadedDiskCount,
    dontMergeReplyBubbles: session.dontMergeReplyBubbles,
    dontMergeHistoricalReplyBubbles: session.dontMergeHistoricalReplyBubbles,
    isPruned: session.isPruned,
    contextPercentage: session.contextPercentage,
    contextInputTokens: session.contextInputTokens,
    contextLength: session.contextLength,
    contextMetrics: session.contextMetrics,
    mainEditorDraft: session.mainEditorDraft,
    symbols: session.symbols,
  });
}

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
  async (id, { getState, dispatch, extra }) => {
    dispatch(deleteSessionMetadata(id)); // optimistic
    deleteCachedSession(id); // remove from LRU cache
    const state = getState();
    if (id === state.session.id) {
      // 当前正在查看的会话就是被删除的会话：切到上一个会话。
      // 传 skipCachingCurrent=id 避免把正在删除的会话重新写回 LRU 缓存
      await dispatch(loadLastSession({ skipCachingCurrent: id }));
    }
    const result = await extra.ideMessenger.request("history/delete", { id });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    void dispatch(refreshSessionMetadata({}));
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
    await extra.ideMessenger.request("history/save", session);
    await dispatch(refreshSessionMetadata({}));
  },
);

/**
 * 保存“后台续流”的会话：流所属会话已在流期间被切走，此时
 * getState().session 是别的会话，完整内容在 LRU 缓存副本里。
 * 标题逻辑与 saveCurrentSession 保持一致（LLM 生成 + 文本回退）。
 */
export const saveSessionFromCache = createAsyncThunk<
  void,
  string,
  ThunkApiType
>("session/saveFromCache", async (sessionId, { dispatch, extra, getState }) => {
  const cached = getCachedSession(sessionId);
  if (!cached) {
    return;
  }

  const selectedChatModel = selectSelectedChatModel(getState());
  let title = cached.title;
  if (
    title === NEW_SESSION_TITLE &&
    !getState().config.config?.disableSessionTitles &&
    selectedChatModel
  ) {
    const assistantResponse = getAssistantResponseText(cached.history);

    if (assistantResponse) {
      // 复用 constructMessages，与发送消息路径对齐：
      // 注入 contextItems、过滤 thinking、处理 file_content 块等
      const withoutMessageIds = cached.history.map((item) => {
        const { id, ...messageWithoutId } = item.message;
        return { ...item, message: messageWithoutId };
      });
      const { messages: compiledMessages } = constructMessages(
        withoutMessageIds,
        undefined,
        [],
        {},
      );

      try {
        const result = await extra.ideMessenger.request(
          "chatDescriber/describe",
          {
            text: assistantResponse,
            // 传对齐后的完整历史，让服务端能识别这不是新会话
            messages: compiledMessages,
          },
        );
        if (result.status === "success" && result.content) {
          title = result.content;
        }
      } catch (e) {
        console.error("Error generating chat title", e);
      }
    }
  }
  if (title === NEW_SESSION_TITLE) {
    const first = cached.history[0];
    title = first ? getChatTitleFromMessage(first.message) : NEW_SESSION_TITLE;
  }
  if (!title.length) {
    title = NEW_SESSION_TITLE;
  }

  const session: Session = {
    sessionId,
    title,
    workspaceDirectory: window.workspacePaths?.[0] || "",
    history: cached.history,
    mode: cached.mode,
    chatModelTitle: cached.chatModelTitle ?? null,
    historyTruncated: cached.historyTruncated,
    historyLoadedOffset: cached.historyLoadedOffset,
    contextMetrics: cached.contextMetrics,
  };
  unwrapResult(await dispatch(updateSession(session)));

  // Only clear the exact cache snapshot that was persisted. A replacement
  // created while the save was in flight must remain dirty.
  const currentCached = getCachedSession(sessionId);
  if (currentCached === cached) {
    setCachedSession(sessionId, {
      ...currentCached,
      title,
      isStreaming: false,
      dirty: false,
    });
  }
});

/*
 this is only used for the custom focusContinueSessionId command at the moment
*/
export const loadSession = createAsyncThunk<
  void,
  {
    sessionId: string;
    saveCurrentSession: boolean;
  },
  ThunkApiType
>(
  "session/load",
  async (
    { sessionId, saveCurrentSession: save },
    { extra, dispatch, getState },
  ) => {
    const isSwitch = sessionId !== getState().session.id;
    // Cache current session before switching (so switching back is instant).
    // 启动场景跳过：redux-persist 持久化 session.id 但不持久化 history，
    // 重启后 state = {id:A, history:[]}。若此时 cacheCurrentSession 会把
    // 伪空 A 写入 LRU，随后 getCachedSession(A) 命中导致跳过磁盘加载，
    // 历史丢失。启动时 sessionId === state.session.id，非"切换"，无需缓存。
    if (isSwitch) {
      cacheCurrentSession(getState());
    }

    if (save) {
      // save the session in the background
      void dispatch(
        saveCurrentSession({
          openNewSession: false,
        }),
      );
    }

    let chatModelTitle: string | null | undefined;
    // 标记是否已通过快照/contextMetrics 恢复了指标。
    // 恢复后若 model 不匹配会再降级到 compile。
    let metricsRestoredFromSnapshot = false;

    // 1. Try LRU cache first — restores full in-memory state (including
    //    lazily-loaded full history and context metrics) without disk read.
    const cached = getCachedSession(sessionId);
    if (cached) {
      dispatch(restoreCachedSession(cached));
      chatModelTitle = cached.chatModelTitle;
      metricsRestoredFromSnapshot = !!cached.contextMetrics;
    } else {
      const lazyLoad = getState().config.config.ui?.lazyLoadHistory;
      if (lazyLoad) {
        const limit =
          getState().config.config.ui?.lazyLoadHistoryInitialCount ?? 4;
        const { session, hasMore, totalCount, loadedOffset } =
          await getSessionPage(extra.ideMessenger, sessionId, limit);
        chatModelTitle = session.chatModelTitle;
        // 标记为 truncated，save 时会合并保留未加载的头部
        session.historyTruncated = hasMore;
        session.historyLoadedOffset = loadedOffset;
        // newSession 会从 session.contextMetrics 还原 4 个指标字段 + 快照
        dispatch(newSession(session));
        dispatch(setHistoryPagination({ hasMore, totalCount }));
        metricsRestoredFromSnapshot = !!session.contextMetrics;
      } else {
        const session = await getSession(extra.ideMessenger, sessionId);
        chatModelTitle = session.chatModelTitle;
        dispatch(newSession(session));
        metricsRestoredFromSnapshot = !!session.contextMetrics;
      }
    }

    // Restore selected chat model from session, if present.
    // Must await so that compileChatForContextMetrics sees the restored model.
    if (chatModelTitle) {
      await dispatch(selectChatModelForProfile(chatModelTitle)).unwrap();
      // 中间若被 React 渲染 168 条消息阻塞，耗时体现在这里
    }

    // 指标恢复路径：
    // - 有快照 + model 一致 → 直接用快照，跳过 compile
    // - 有快照但 model 已切 → 快照 stale，清掉重新 compile
    // - 无快照（旧会话文件） → compile 兜底
    if (metricsRestoredFromSnapshot) {
      const restoredModelTitle = selectSelectedChatModel(getState())?.title;
      if (restoredModelTitle && restoredModelTitle === chatModelTitle) {
        // 快照与当前 model 一致，直接使用
      } else {
        dispatch(clearContextMetrics());
        try {
          await dispatch(compileChatForContextMetrics()).unwrap();
        } catch (e) {
          console.warn("Post-load compile failed", e);
        }
      }
    } else {
      try {
        await dispatch(compileChatForContextMetrics()).unwrap();
      } catch (e) {
        console.warn("Post-load compile failed", e);
      }
    }
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
>("session/loadLast", async (arg, { extra, dispatch, getState }) => {
  const skipCachingCurrent = arg?.skipCachingCurrent;
  const stateBefore = getState();
  // Cache current session before switching, unless it's the one being deleted.
  // 当前 history 为空时跳过：避免 redux-persist 恢复的伪空 session
  // （{id:A, history:[]}，磁盘有历史）被缓存后，切回 A 命中缓存跳过磁盘加载。
  if (
    stateBefore.session.history.length > 0 &&
    (!skipCachingCurrent || skipCachingCurrent !== stateBefore.session.id)
  ) {
    cacheCurrentSession(stateBefore);
  }

  let lastSessionId = getState().session.lastSessionId;

  if (!lastSessionId) {
    dispatch(newSession());
    return;
  }

  let chatModelTitle: string | null | undefined;
  // 标记是否已通过快照/contextMetrics 恢复了指标
  let metricsRestoredFromSnapshot = false;

  // 1. Try LRU cache first
  const cached = getCachedSession(lastSessionId);
  if (cached) {
    dispatch(restoreCachedSession(cached));
    chatModelTitle = cached.chatModelTitle;
    metricsRestoredFromSnapshot = !!cached.contextMetrics;
  } else {
    const lazyLoad = getState().config.config.ui?.lazyLoadHistory;
    const limit = getState().config.config.ui?.lazyLoadHistoryInitialCount ?? 4;

    if (lazyLoad) {
      let pageResult: Awaited<ReturnType<typeof getSessionPage>>;
      try {
        pageResult = await getSessionPage(
          extra.ideMessenger,
          lastSessionId,
          limit,
        );
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        pageResult = await getSessionPage(
          extra.ideMessenger,
          lastSessionId,
          limit,
        );
      }
      const { session, hasMore, totalCount, loadedOffset } = pageResult;
      chatModelTitle = session.chatModelTitle;
      session.historyTruncated = hasMore;
      session.historyLoadedOffset = loadedOffset;
      // newSession 会从 session.contextMetrics 还原 4 个指标字段 + 快照
      dispatch(newSession(session));
      dispatch(setHistoryPagination({ hasMore, totalCount }));
      metricsRestoredFromSnapshot = !!session.contextMetrics;
    } else {
      let session: Session;
      try {
        session = await getSession(extra.ideMessenger, lastSessionId);
      } catch {
        // retry again after 1 sec
        await new Promise((resolve) => setTimeout(resolve, 1000));
        session = await getSession(extra.ideMessenger, lastSessionId);
      }
      chatModelTitle = session.chatModelTitle;
      dispatch(newSession(session));
      metricsRestoredFromSnapshot = !!session.contextMetrics;
    }
  }

  // Must await so that compileChatForContextMetrics sees the restored model.
  if (chatModelTitle) {
    await dispatch(selectChatModelForProfile(chatModelTitle)).unwrap();
  }

  // 指标恢复路径同 loadSession
  if (metricsRestoredFromSnapshot) {
    const restoredModelTitle = selectSelectedChatModel(getState())?.title;
    if (restoredModelTitle && restoredModelTitle === chatModelTitle) {
      // 快照与当前 model 一致，直接使用
    } else {
      dispatch(clearContextMetrics());
      try {
        await dispatch(compileChatForContextMetrics()).unwrap();
      } catch (e) {
        console.warn("Post-load compile failed", e);
      }
    }
  } else {
    try {
      await dispatch(compileChatForContextMetrics()).unwrap();
    } catch (e) {
      console.warn("Post-load compile failed", e);
    }
  }
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
function getAssistantResponseText(
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

function getChatTitleFromMessage(message: ChatMessage) {
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
>(
  "session/saveCurrent",
  async ({ openNewSession }, { dispatch, extra, getState }) => {
    const session = getState().session; // assign to a variable so that even when current session changes, we have the reference to the old session
    if (session.history.length === 0) {
      // 空 session 上再次触发 newSession（如连续点 "+" 按钮）：
      // 跳过 save，但仍需 dispatch newSession 让 UI 生成新 tab，
      // 否则 currentSessionId 不变，TabBar 不会创建新 tab。
      if (openNewSession) {
        dispatch(newSession());
      }
      return;
    }

    // Cache current session before opening a new one (so user can switch back)
    if (openNewSession) {
      cacheCurrentSession(getState());
      dispatch(newSession());
    }

    // 脏标记跳过：会话内容（history/title/metrics/mode）自上次成功保存后
    // 未变更（分页加载只读不写盘，不置脏），history/save 是纯冗余 ——
    // 长会话的全量 structured clone + 写盘会阻塞后续 IPC ~2s。
    // 标题仍是 NEW_SESSION_TITLE 的会话不跳过：需要生成标题并落盘。
    if (!session.dirty && session.title !== NEW_SESSION_TITLE) {
      return;
    }

    const selectedChatModel = selectSelectedChatModel(getState());

    // New session has already been dispatched
    // Now save previous session and update chat title if relevant
    let title = session.title;
    if (title === NEW_SESSION_TITLE) {
      // 仅在标题仍是默认 "New Session" 时才生成标题，避免每次流式响应结束都调用 LLM。
      // 已有自定义标题的会话不再重复生成，节省 LLM 调用。
      if (
        !getState().config.config?.disableSessionTitles &&
        selectedChatModel
      ) {
        let assistantResponse = getAssistantResponseText(session.history);

        if (assistantResponse) {
          // 复用 constructMessages，与发送消息路径对齐：
          // 注入 contextItems、过滤 thinking、处理 file_content 块等
          const withoutMessageIds = session.history.map((item) => {
            const { id, ...messageWithoutId } = item.message;
            return { ...item, message: messageWithoutId };
          });
          const { messages: compiledMessages } = constructMessages(
            withoutMessageIds,
            undefined,
            [],
            {},
          );

          try {
            const result = await extra.ideMessenger.request(
              "chatDescriber/describe",
              {
                text: assistantResponse,
                // 传对齐后的完整历史，让服务端能识别这不是新会话
                messages: compiledMessages,
              },
            );
            if (result.status === "success" && result.content) {
              title = result.content;
            }
          } catch (e) {
            console.error("Error generating chat title", e);
          }
        }
      }
      // Fallbacks if above doesn't work out or session titles disabled
      if (title === NEW_SESSION_TITLE) {
        title = getChatTitleFromMessage(session.history[0].message);
      }
    }
    // More fallbacks in case of no title
    if (!title.length) {
      const metadata = session.allSessionMetadata.find(
        (m) => m.sessionId === session.id,
      );
      if (metadata?.title) {
        title = metadata.title;
      }
    }
    if (!title.length) {
      title = NEW_SESSION_TITLE;
    }

    const updatedSession: Session = {
      sessionId: session.id,
      title,
      workspaceDirectory: window.workspacePaths?.[0] || "",
      history: session.history,
      mode: session.mode,
      chatModelTitle: selectedChatModel?.title ?? null,
      // 懒加载合并保存：把分页标记传给后端，save 时保留未加载的头部
      historyTruncated: session.historyTruncated,
      historyLoadedOffset: session.historyLoadedOffset,
      // 持久化 context 指标快照，下次加载会话时直接还原
      contextMetrics: session.contextMetrics,
    };
    // Retain the cache identity observed before persisting. A background
    // stream may replace it while the write is in flight; that replacement
    // must stay dirty because its contents are newer than this snapshot.
    const cachedBeforeSave = getCachedSession(session.id);
    const result = await dispatch(updateSession(updatedSession));
    unwrapResult(result);

    // 持久化成功：清脏标记（当前会话）+ 同步 LRU 缓存副本
    dispatch(markSessionPersisted(session.id));
    if (
      cachedBeforeSave &&
      getCachedSession(session.id) === cachedBeforeSave &&
      !cachedBeforeSave.isStreaming
    ) {
      setCachedSession(session.id, { ...cachedBeforeSave, dirty: false });
    }
  },
);
