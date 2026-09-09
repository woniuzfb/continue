import { PayloadAction, createSlice } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ApplyState,
  ChatMessage,
  ContextItemWithId,
  FileSymbolMap,
  MessageModes,
  RuleMetadata,
  SetCodeToEditPayload,
  ToolCallState,
} from "core";
import type { SessionPersistenceErrorCode } from "core/util/sessionPersistenceError";
import { type InlineErrorMessageType } from "../../components/mainInput/InlineErrorMessage";
import { type AttachedFile } from "../../components/mainInput/types";
import {
  ChatHistoryItemWithMessageId,
  ContextMetricsSnapshot,
  applyStreamUpdatesToHistory,
  mergeSplitReplies,
} from "./sessionSlice";

/**
 * Phase 1 session ownership.
 *
 * `sessionsById` is the single runtime owner of every open session; a tab is
 * just a projection (`tabOrder` + `tabDescriptors`). Only `activeSessionId`,
 * `tabOrder` and `tabDescriptors` are persisted (see store.ts) — never the
 * runtime state, which holds AbortControllers, streams and pagination requests.
 */

export type SessionPersistenceStatus =
  | "clean"
  | "pending"
  | "saving"
  | "failed";

export type SessionPersistenceState = {
  state: SessionPersistenceStatus;
  revision: number;
  persistedRevision: number;
  hasPersistedBaseline: boolean;
  error?: {
    code: SessionPersistenceErrorCode;
    message: string;
  };
};

export type SessionScrollState = {
  scrollTop: number;
  scrollHeight: number;
  isFollowingBottom: boolean;
  anchorMessageId?: string;
  anchorOffsetPx?: number;
  restoreGeneration: number;
};

export type SessionEditRuntimeState = {
  codeToEdit: SetCodeToEditPayload[];
  applyState: ApplyState;
  returnToMode: MessageModes;
  lastNonEditSessionWasEmpty: boolean;
  previousModeEditorContent?: JSONContent;
};

export type SessionPaginationState = {
  truncated: boolean;
  loadedOffset: number;
  totalCount?: number;
  loadedDiskCount?: number;
  hasMore: boolean;
  loading: boolean;
  requestGeneration: number;
  persistPending: boolean;
};

export type SessionStreamState = {
  status: "idle" | "streaming" | "aborting" | "failed";
  requestId?: string;
  aborter?: AbortController;
  error?: string;
};

/**
 * Identity of a context-metrics snapshot (方案.md §五.16). A snapshot may only
 * be reused when the model, the history revision and the schema all match.
 */
export type ContextMetricsMeta = {
  modelIdentity: string;
  historyRevision: number;
  schemaVersion: number;
};

export type SessionRuntimeState = {
  id: string;
  title: string;

  history: ChatHistoryItemWithMessageId[];
  /** Bumped by every request-relevant mutation; gates metrics recomputation. */
  historyRevision: number;
  firstTurnItems: ChatHistoryItemWithMessageId[];
  latestConversationSummary?: {
    sourceMessageId: string;
    content: string;
  };

  mode: MessageModes;
  chatModelTitle?: string;
  hasReasoningEnabled?: boolean;
  reasoningPreferenceSource?: "derived" | "explicit";

  symbols: FileSymbolMap;
  mainEditorContentTrigger?: JSONContent;
  mainEditorAttachmentsRestore?: AttachedFile[];
  mainEditorDraft?: JSONContent;
  isInEdit: boolean;

  codeBlockApplyStates: {
    states: ApplyState[];
    curIndex: number;
  };
  newestToolbarPreviewForInput: Record<string, string>;

  isPruned?: boolean;
  contextPercentage?: number;
  contextInputTokens?: number;
  contextLength?: number;
  contextMetrics?: ContextMetricsSnapshot;
  contextMetricsMeta?: ContextMetricsMeta;

  inlineErrorMessage?: InlineErrorMessageType;
  compactionLoading: Record<string, boolean>;

  /** Per-session snapshot of the global config.ui merge settings. */
  dontMergeReplyBubbles?: boolean;
  dontMergeHistoricalReplyBubbles?: boolean;

  stream: SessionStreamState;
  pagination: SessionPaginationState;
  editState: SessionEditRuntimeState;
  scrollState: SessionScrollState;
  persistence?: SessionPersistenceState;

  pendingApprovalCount: number;
  dirty: boolean;
  lifecycle: { closing: boolean };
};

export type SessionTabDescriptor = {
  sessionId: string;
  title: string;
  loadState: "unloaded" | "loading" | "loaded" | "failed";
  mode?: MessageModes;
  persistedEditState?: {
    returnToMode?: MessageModes;
    lastNonEditSessionWasEmpty?: boolean;
    codeToEdit?: SetCodeToEditPayload[];
  };
};

export type SessionsState = {
  activeSessionId?: string;
  tabOrder: string[];
  tabDescriptors: Record<string, SessionTabDescriptor>;
  sessionsById: Record<string, SessionRuntimeState>;
};

export const initialSessionsState: SessionsState = {
  activeSessionId: undefined,
  tabOrder: [],
  tabDescriptors: {},
  sessionsById: {},
};

export function initialSessionRuntime(
  sessionId: string,
  title: string,
  overrides: Partial<SessionRuntimeState> = {},
): SessionRuntimeState {
  return {
    id: sessionId,
    title,
    history: [],
    historyRevision: 0,
    firstTurnItems: [],
    mode: "chat",
    symbols: {},
    isInEdit: false,
    codeBlockApplyStates: { states: [], curIndex: 0 },
    newestToolbarPreviewForInput: {},
    compactionLoading: {},
    stream: { status: "idle" },
    pagination: {
      truncated: false,
      loadedOffset: 0,
      hasMore: false,
      loading: false,
      requestGeneration: 0,
      persistPending: false,
    },
    editState: {
      codeToEdit: [],
      applyState: {
        streamId: "chat",
        status: "not-started",
      } as ApplyState,
      returnToMode: "chat",
      lastNonEditSessionWasEmpty: false,
    },
    scrollState: {
      scrollTop: 0,
      scrollHeight: 0,
      isFollowingBottom: true,
      restoreGeneration: 0,
    },
    pendingApprovalCount: 0,
    dirty: false,
    lifecycle: { closing: false },
    ...overrides,
  };
}

/**
 * A tool call that has been generated by the model but not yet executed is
 * waiting for the user's approval. The count is always derived from the
 * history, never stored independently (方案.md §六 Tool/Compact).
 */
export function countAwaitingApprovalToolCalls(
  history: ChatHistoryItemWithMessageId[],
): number {
  let count = 0;
  for (const item of history) {
    for (const toolCallState of item.toolCallStates ?? []) {
      if (toolCallState.status === "generated") {
        count++;
      }
    }
  }
  return count;
}

function findRuntime(
  state: SessionsState,
  sessionId: string,
): SessionRuntimeState | undefined {
  return state.sessionsById[sessionId];
}

function findItemByMessageId(
  session: SessionRuntimeState,
  messageId: string,
): ChatHistoryItemWithMessageId | undefined {
  return session.history.find((item) => item.message.id === messageId);
}

function invalidateContextMetrics(session: SessionRuntimeState): void {
  session.isPruned = false;
  session.contextPercentage = undefined;
  session.contextInputTokens = undefined;
  session.contextLength = undefined;
  session.contextMetrics = undefined;
  session.contextMetricsMeta = undefined;
}

/**
 * Every mutation that changes the request history (messages, context items,
 * applied rules, summary, mode) marks the session dirty and advances
 * `historyRevision`, which is what the metrics recompute gate compares.
 */
function markHistoryChanged(session: SessionRuntimeState): void {
  session.dirty = true;
  session.historyRevision += 1;
}

export const sessionsSlice = createSlice({
  name: "sessions",
  initialState: initialSessionsState,
  reducers: {
    // ── Runtime lifecycle / Tab descriptor ────────────────────────────────
    createSessionRuntime: (
      state,
      action: PayloadAction<{ session: SessionRuntimeState }>,
    ) => {
      const { session } = action.payload;
      state.sessionsById[session.id] = session;
      state.tabDescriptors[session.id] = {
        sessionId: session.id,
        title: session.title,
        loadState: "loaded",
        mode: session.mode,
      };
      if (!state.tabOrder.includes(session.id)) {
        state.tabOrder.push(session.id);
      }
    },
    removeSessionRuntime: (
      state,
      action: PayloadAction<{ sessionId: string }>,
    ) => {
      delete state.sessionsById[action.payload.sessionId];
    },
    setSessionClosing: (
      state,
      action: PayloadAction<{ sessionId: string; closing: boolean }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.lifecycle.closing = action.payload.closing;
      }
    },
    setActiveSessionId: (
      state,
      action: PayloadAction<{ sessionId: string | undefined }>,
    ) => {
      state.activeSessionId = action.payload.sessionId;
    },
    setTabDescriptor: (
      state,
      action: PayloadAction<{ descriptor: SessionTabDescriptor }>,
    ) => {
      const { descriptor } = action.payload;
      state.tabDescriptors[descriptor.sessionId] = descriptor;
      if (!state.tabOrder.includes(descriptor.sessionId)) {
        state.tabOrder.push(descriptor.sessionId);
      }
    },
    setTabLoadState: (
      state,
      action: PayloadAction<{
        sessionId: string;
        loadState: SessionTabDescriptor["loadState"];
      }>,
    ) => {
      const descriptor = state.tabDescriptors[action.payload.sessionId];
      if (descriptor) {
        descriptor.loadState = action.payload.loadState;
      }
    },
    /**
     * Atomic close transaction (方案.md §五.19): the thunk/action creator
     * computes the closing id, the neighbour replacement id and any new empty
     * session id up front, then this single reducer action removes the visible
     * tab, updates descriptors, activates the replacement and optionally
     * creates the new empty runtime. No IO, no UUID generation here.
     *
     * The runtime owner is intentionally NOT removed: streaming / pending /
     * failed / awaiting-approval sessions keep their owner until clean
     * (方案.md §八). Callers release it with removeSessionRuntime.
     */
    closeSessionTabTransaction: (
      state,
      action: PayloadAction<{
        sessionId: string;
        replacementSessionId?: string;
        newEmptySession?: SessionRuntimeState;
      }>,
    ) => {
      const { sessionId, replacementSessionId, newEmptySession } =
        action.payload;
      state.tabOrder = state.tabOrder.filter((id) => id !== sessionId);
      delete state.tabDescriptors[sessionId];

      if (newEmptySession) {
        state.sessionsById[newEmptySession.id] = newEmptySession;
        state.tabDescriptors[newEmptySession.id] = {
          sessionId: newEmptySession.id,
          title: newEmptySession.title,
          loadState: "loaded",
          mode: newEmptySession.mode,
        };
        state.tabOrder.push(newEmptySession.id);
      }

      const replacement =
        replacementSessionId &&
        state.tabDescriptors[replacementSessionId] !== undefined
          ? replacementSessionId
          : state.tabOrder[state.tabOrder.length - 1];
      state.activeSessionId = replacement;
    },
    setSessionTitle: (
      state,
      action: PayloadAction<{ sessionId: string; title: string }>,
    ) => {
      const { sessionId, title } = action.payload;
      // runtime.title is the authority for a loaded session; the descriptor is
      // only an unloaded placeholder and must stay in sync (方案.md §五.20).
      const session = findRuntime(state, sessionId);
      if (session) {
        session.title = title;
      }
      const descriptor = state.tabDescriptors[sessionId];
      if (descriptor) {
        descriptor.title = title;
      }
    },

    // ── History / Message identity ────────────────────────────────────────
    setSessionHistory: (
      state,
      action: PayloadAction<{
        sessionId: string;
        history: ChatHistoryItemWithMessageId[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.history = action.payload.history;
        session.historyRevision += 1;
      }
    },
    setContextItemsByMessageId: (
      state,
      action: PayloadAction<{
        sessionId: string;
        messageId: string;
        contextItems: ContextItemWithId[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      const item = session
        ? findItemByMessageId(session, action.payload.messageId)
        : undefined;
      if (session && item) {
        markHistoryChanged(session);
        item.contextItems = action.payload.contextItems;
      }
    },
    addContextItemsByMessageId: (
      state,
      action: PayloadAction<{
        sessionId: string;
        messageId: string;
        contextItems: ContextItemWithId[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      const item = session
        ? findItemByMessageId(session, action.payload.messageId)
        : undefined;
      if (session && item) {
        markHistoryChanged(session);
        item.contextItems = [
          ...item.contextItems,
          ...action.payload.contextItems,
        ];
      }
    },
    updateHistoryItemByMessageId: (
      state,
      action: PayloadAction<{
        sessionId: string;
        messageId: string;
        updates: Partial<ChatHistoryItemWithMessageId>;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      const item = session
        ? findItemByMessageId(session, action.payload.messageId)
        : undefined;
      if (!session || !item) {
        return;
      }
      markHistoryChanged(session);
      Object.assign(item, action.payload.updates);
      // Editing/retrying invalidates the previous context snapshot, and a tool
      // state change changes the pending-approval projection.
      invalidateContextMetrics(session);
      session.pendingApprovalCount = countAwaitingApprovalToolCalls(
        session.history,
      );
    },
    setAppliedRulesByMessageId: (
      state,
      action: PayloadAction<{
        sessionId: string;
        messageId: string;
        appliedRules: RuleMetadata[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      const item = session
        ? findItemByMessageId(session, action.payload.messageId)
        : undefined;
      if (session && item) {
        markHistoryChanged(session);
        item.appliedRules = action.payload.appliedRules;
      }
    },
    deleteTurnByMessageId: (
      state,
      action: PayloadAction<{ sessionId: string; messageId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const index = session.history.findIndex(
        (item) => item.message.id === action.payload.messageId,
      );
      if (index < 0) {
        return;
      }
      // A turn runs from its user message up to (not including) the next user
      // message. Deleting by identity never depends on a window offset.
      let start = index;
      while (start > 0 && session.history[start].message.role !== "user") {
        start--;
      }
      let end = start + 1;
      while (
        end < session.history.length &&
        session.history[end].message.role !== "user"
      ) {
        end++;
      }
      session.history.splice(start, end - start);
      markHistoryChanged(session);
      invalidateContextMetrics(session);
      session.pendingApprovalCount = countAwaitingApprovalToolCalls(
        session.history,
      );
    },
    truncateHistoryAfterMessageId: (
      state,
      action: PayloadAction<{
        sessionId: string;
        messageId: string;
        assistantPlaceholderId?: string;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const index = session.history.findIndex(
        (item) => item.message.id === action.payload.messageId,
      );
      if (index < 0 || index >= session.history.length) {
        return;
      }
      session.codeBlockApplyStates.curIndex = 0;
      session.history = session.history.slice(0, index + 1).concat({
        message: {
          id: action.payload.assistantPlaceholderId ?? "",
          role: "assistant",
          content: "",
        },
        contextItems: [],
      });
      session.inlineErrorMessage = undefined;
      markHistoryChanged(session);
      invalidateContextMetrics(session);
      session.pendingApprovalCount = 0;
    },

    // ── First turn / Summary ──────────────────────────────────────────────
    setSessionFirstTurn: (
      state,
      action: PayloadAction<{
        sessionId: string;
        firstTurnItems: ChatHistoryItemWithMessageId[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.firstTurnItems = action.payload.firstTurnItems;
        session.historyRevision += 1;
      }
    },
    setSessionConversationSummary: (
      state,
      action: PayloadAction<{
        sessionId: string;
        summary: { sourceMessageId: string; content: string };
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.latestConversationSummary = action.payload.summary;
        session.historyRevision += 1;
      }
    },
    clearSessionConversationSummary: (
      state,
      action: PayloadAction<{ sessionId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.latestConversationSummary = undefined;
        session.historyRevision += 1;
      }
    },

    // ── Stream ────────────────────────────────────────────────────────────
    beginSessionStream: (
      state,
      action: PayloadAction<{
        sessionId: string;
        requestId: string;
        aborter?: AbortController;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.stream = {
          status: "streaming",
          requestId: action.payload.requestId,
          aborter: action.payload.aborter,
        };
      }
    },
    applySessionStreamUpdate: (
      state,
      action: PayloadAction<{
        sessionId: string;
        requestId: string;
        messages: ChatMessage[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      // Stale stream completion must never touch a newer stream.
      if (!session || session.stream.requestId !== action.payload.requestId) {
        return;
      }
      markHistoryChanged(session);
      applyStreamUpdatesToHistory(session, action.payload.messages);
    },
    /**
     * The model is no longer streaming but the request is still live: the
     * session is waiting for tool approval or for an edit apply to finish
     * (方案.md §五.20). Keeps `requestId` so the tool loop can continue the
     * same turn, and keeps the aborter so Stop still works.
     */
    pauseSessionStream: (
      state,
      action: PayloadAction<{ sessionId: string; requestId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session || session.stream.requestId !== action.payload.requestId) {
        return;
      }
      session.stream = {
        status: "idle",
        requestId: action.payload.requestId,
        aborter: session.stream.aborter,
      };
    },
    finishSessionStream: (
      state,
      action: PayloadAction<{
        sessionId: string;
        requestId: string;
        status: "completed" | "aborted" | "failed";
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session || session.stream.requestId !== action.payload.requestId) {
        return;
      }
      const { error } = session.stream;
      session.stream = {
        status: action.payload.status === "completed" ? "idle" : "failed",
        // Terminal failure keeps its error metadata for the recovery entry
        // (方案.md §七.4); the requestId itself is released.
        ...(action.payload.status === "failed" && error ? { error } : {}),
      };
    },
    setSessionStreamError: (
      state,
      action: PayloadAction<{
        sessionId: string;
        requestId: string;
        error: string;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session || session.stream.requestId !== action.payload.requestId) {
        return;
      }
      session.stream = {
        status: "failed",
        requestId: action.payload.requestId,
        error: action.payload.error,
      };
    },

    // ── Pagination ────────────────────────────────────────────────────────
    setSessionPagination: (
      state,
      action: PayloadAction<{
        sessionId: string;
        pagination: Partial<SessionPaginationState>;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.pagination = {
          ...session.pagination,
          ...action.payload.pagination,
        };
      }
    },
    prependSessionHistory: (
      state,
      action: PayloadAction<{
        sessionId: string;
        items: ChatHistoryItemWithMessageId[];
        hasMore: boolean;
        newLoadedOffset: number;
        totalCount: number;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session || !session.pagination.truncated) {
        return;
      }
      const { items, hasMore, newLoadedOffset, totalCount } = action.payload;
      // Disk accounting uses the raw page size, before any GUI bubble merge.
      session.pagination.loadedDiskCount =
        (session.pagination.loadedDiskCount ?? session.history.length) +
        items.length;
      session.history =
        (session.dontMergeHistoricalReplyBubbles ?? true)
          ? [...items, ...session.history]
          : mergeSplitReplies([...items, ...session.history]);
      session.pagination.loadedOffset = newLoadedOffset;
      session.pagination.hasMore = hasMore;
      session.pagination.totalCount = totalCount;
      session.pagination.truncated = hasMore;
      session.pagination.loading = false;
      // Prepending older history changes the request history.
      session.historyRevision += 1;
    },
    setSessionHistoryLoading: (
      state,
      action: PayloadAction<{ sessionId: string; loading: boolean }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.pagination.loading = action.payload.loading;
      }
    },
    /**
     * Trim is only allowed when the caller could reliably map GUI items to
     * disk items (方案.md §九.6): it must pass the exact disk accounting.
     * This reducer never guesses.
     */
    trimSessionHistoryWindow: (
      state,
      action: PayloadAction<{
        sessionId: string;
        keepCount: number;
        removedDiskItems: number;
        fullDiskItemCount: number;
        retainedDiskItemCount: number;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session || action.payload.keepCount < 0) {
        return;
      }
      const {
        keepCount,
        removedDiskItems,
        fullDiskItemCount,
        retainedDiskItemCount,
      } = action.payload;
      if (keepCount < session.history.length) {
        session.history = session.history.slice(
          session.history.length - keepCount,
        );
        session.historyRevision += 1;
      }
      const pagination = session.pagination;
      pagination.truncated = removedDiskItems > 0;
      pagination.loadedOffset =
        pagination.loadedOffset + Math.max(removedDiskItems, 0);
      pagination.totalCount = fullDiskItemCount;
      pagination.loadedDiskCount = retainedDiskItemCount;
      pagination.hasMore = removedDiskItems > 0;
      pagination.loading = false;
      // Every trim invalidates in-flight paging results.
      pagination.requestGeneration++;
      pagination.persistPending = session.dirty;
    },

    // ── Persistence ───────────────────────────────────────────────────────
    setSessionPersistenceState: (
      state,
      action: PayloadAction<{
        sessionId: string;
        persistence: SessionPersistenceState;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.persistence = action.payload.persistence;
      }
    },
    /**
     * Marks a session dirty and advances the save-queue revision (方案.md
     * §七.1/§七.3): `revision` is what the per-session save queue compares to
     * decide whether a newer snapshot is still pending.
     */
    markSessionDirty: (state, action: PayloadAction<{ sessionId: string }>) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      session.dirty = true;
      const persistence = session.persistence ?? {
        state: "clean" as const,
        revision: 0,
        persistedRevision: 0,
        hasPersistedBaseline: false,
      };
      session.persistence = {
        ...persistence,
        state: persistence.state === "saving" ? "saving" : "pending",
        revision: persistence.revision + 1,
      };
    },
    markSessionPersisted: (
      state,
      action: PayloadAction<{
        sessionId: string;
        revision?: number;
        hasPersistedBaseline?: boolean;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const { revision, hasPersistedBaseline } = action.payload;
      const persistence = session.persistence ?? {
        state: "clean",
        revision: 0,
        persistedRevision: 0,
        hasPersistedBaseline: false,
      };
      if (revision !== undefined) {
        persistence.persistedRevision = revision;
        persistence.state =
          persistence.persistedRevision === persistence.revision
            ? "clean"
            : "pending";
      }
      if (hasPersistedBaseline !== undefined) {
        persistence.hasPersistedBaseline = hasPersistedBaseline;
      }
      persistence.error = undefined;
      session.persistence = persistence;
      if (persistence.state === "clean") {
        session.dirty = false;
        session.pagination.persistPending = false;
      }
    },

    // ── Editor / Edit / Apply ─────────────────────────────────────────────
    setSessionMainEditorDraft: (
      state,
      action: PayloadAction<{ sessionId: string; draft?: JSONContent }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.mainEditorDraft = action.payload.draft;
      }
    },
    setSessionMainEditorContentTrigger: (
      state,
      action: PayloadAction<{ sessionId: string; content?: JSONContent }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.mainEditorContentTrigger = action.payload.content;
      }
    },
    setSessionMainEditorAttachmentsRestore: (
      state,
      action: PayloadAction<{
        sessionId: string;
        attachments?: AttachedFile[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.mainEditorAttachmentsRestore = action.payload.attachments;
      }
    },
    /**
     * Config-derived UI merge settings for one session (方案.md §五.28):
     * written by the config listener, never mirrored from a render effect.
     */
    setSessionMergeSettings: (
      state,
      action: PayloadAction<{
        sessionId: string;
        dontMergeReplyBubbles?: boolean;
        dontMergeHistoricalReplyBubbles?: boolean;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      if (action.payload.dontMergeReplyBubbles !== undefined) {
        session.dontMergeReplyBubbles = action.payload.dontMergeReplyBubbles;
      }
      if (action.payload.dontMergeHistoricalReplyBubbles !== undefined) {
        session.dontMergeHistoricalReplyBubbles =
          action.payload.dontMergeHistoricalReplyBubbles;
      }
    },
    /**
     * Marks the last history item as gathering context (方案.md §五.20).
     * `isGatheringContext` lives on the history item, so this is a targeted
     * item write rather than a session flag.
     */
    setSessionGatheringContext: (
      state,
      action: PayloadAction<{ sessionId: string; gathering: boolean }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      const lastItem = session?.history.at(-1);
      if (lastItem) {
        lastItem.isGatheringContext = action.payload.gathering;
      }
    },
    setSessionIsInEdit: (
      state,
      action: PayloadAction<{ sessionId: string; isInEdit: boolean }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.isInEdit = action.payload.isInEdit;
      }
    },
    setSessionCodeToEdit: (
      state,
      action: PayloadAction<{
        sessionId: string;
        codeToEdit: SetCodeToEditPayload[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.editState.codeToEdit = action.payload.codeToEdit;
      }
    },
    updateSessionEditApplyState: (
      state,
      action: PayloadAction<{
        sessionId: string;
        updates: Partial<ApplyState>;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.editState.applyState = {
          ...session.editState.applyState,
          ...action.payload.updates,
        };
      }
    },
    setSessionReturnToMode: (
      state,
      action: PayloadAction<{ sessionId: string; mode: MessageModes }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.editState.returnToMode = action.payload.mode;
      }
    },
    setSessionPreviousModeEditorContent: (
      state,
      action: PayloadAction<{
        sessionId: string;
        content?: JSONContent;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.editState.previousModeEditorContent = action.payload.content;
      }
    },
    /**
     * Chat/agent code-block apply state (方案.md §六 Editor/Edit/Apply).
     * Mirrors the legacy `updateApplyState`, including the `curIndex` advance
     * on `done`, but for one explicit session.
     */
    updateSessionApplyState: (
      state,
      action: PayloadAction<{ sessionId: string; applyState: ApplyState }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const { applyState } = action.payload;
      const existing = session.codeBlockApplyStates.states.find(
        (candidate) => candidate.streamId === applyState.streamId,
      );
      if (!existing) {
        session.codeBlockApplyStates.states.push(applyState);
      } else {
        existing.status = applyState.status ?? existing.status;
        existing.numDiffs = applyState.numDiffs ?? existing.numDiffs;
        existing.filepath = applyState.filepath ?? existing.filepath;
        existing.fileContent = applyState.fileContent ?? existing.fileContent;
        existing.originalFileContent =
          applyState.originalFileContent ?? existing.originalFileContent;
      }
      if (applyState.status === "done") {
        session.codeBlockApplyStates.curIndex++;
      }
    },
    /**
     * Session-scoped equivalent of `resetNextCodeBlockToApplyIndex`. The tool
     * loop resets the cursor before continuing a turn so the next reply's code
     * blocks apply from the start.
     */
    resetSessionCodeBlockApplyIndex: (
      state,
      action: PayloadAction<{ sessionId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.codeBlockApplyStates.curIndex = 0;
      }
    },

    // ── Tool / Compact ────────────────────────────────────────────────────
    setCompactionLoadingByMessageId: (
      state,
      action: PayloadAction<{
        sessionId: string;
        messageId: string;
        loading: boolean;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      if (action.payload.loading) {
        session.compactionLoading[action.payload.messageId] = true;
      } else {
        delete session.compactionLoading[action.payload.messageId];
      }
    },
    deleteCompactionByMessageId: (
      state,
      action: PayloadAction<{ sessionId: string; messageId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      const item = session
        ? findItemByMessageId(session, action.payload.messageId)
        : undefined;
      if (session && item?.conversationSummary) {
        markHistoryChanged(session);
        item.conversationSummary = undefined;
      }
    },

    // ── Model / Mode / Reasoning ──────────────────────────────────────────
    setSessionMode: (
      state,
      action: PayloadAction<{ sessionId: string; mode: MessageModes }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.mode = action.payload.mode;
        session.historyRevision += 1;
        const descriptor = state.tabDescriptors[action.payload.sessionId];
        if (descriptor) {
          descriptor.mode = action.payload.mode;
        }
      }
    },
    setSessionChatModelTitle: (
      state,
      action: PayloadAction<{ sessionId: string; chatModelTitle?: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.chatModelTitle = action.payload.chatModelTitle;
      }
    },
    setSessionReasoningEnabled: (
      state,
      action: PayloadAction<{ sessionId: string; enabled?: boolean }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.hasReasoningEnabled = action.payload.enabled;
      }
    },
    setSessionReasoningPreferenceSource: (
      state,
      action: PayloadAction<{
        sessionId: string;
        source?: "derived" | "explicit";
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.reasoningPreferenceSource = action.payload.source;
      }
    },

    // ── Runtime presentation ──────────────────────────────────────────────
    setSessionNewestToolbarPreviewForInput: (
      state,
      action: PayloadAction<{
        sessionId: string;
        inputId: string;
        contextItemId: string;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.newestToolbarPreviewForInput[action.payload.inputId] =
          action.payload.contextItemId;
      }
    },
    setSessionSymbols: (
      state,
      action: PayloadAction<{ sessionId: string; symbols: FileSymbolMap }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.symbols = action.payload.symbols;
      }
    },
    setSessionInlineError: (
      state,
      action: PayloadAction<{
        sessionId: string;
        error?: InlineErrorMessageType;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.inlineErrorMessage = action.payload.error;
      }
    },
    setSessionContextMetrics: (
      state,
      action: PayloadAction<{
        sessionId: string;
        metrics?: ContextMetricsSnapshot;
        meta?: ContextMetricsMeta;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      session.contextMetrics = action.payload.metrics;
      session.contextMetricsMeta = action.payload.metrics
        ? action.payload.meta
        : undefined;
      session.isPruned = action.payload.metrics?.didPrune;
      session.contextPercentage = action.payload.metrics?.contextPercentage;
      session.contextInputTokens = action.payload.metrics?.inputTokens;
      session.contextLength = action.payload.metrics?.contextLength;
    },
    setSessionScrollState: (
      state,
      action: PayloadAction<{
        sessionId: string;
        scrollState: Partial<SessionScrollState>;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.scrollState = {
          ...session.scrollState,
          ...action.payload.scrollState,
        };
      }
    },
  },
});

export const {
  createSessionRuntime,
  removeSessionRuntime,
  setSessionClosing,
  setActiveSessionId,
  setTabDescriptor,
  setTabLoadState,
  closeSessionTabTransaction,
  setSessionTitle,
  setSessionHistory,
  setContextItemsByMessageId,
  addContextItemsByMessageId,
  updateHistoryItemByMessageId,
  setAppliedRulesByMessageId,
  deleteTurnByMessageId,
  truncateHistoryAfterMessageId,
  setSessionFirstTurn,
  setSessionConversationSummary,
  clearSessionConversationSummary,
  beginSessionStream,
  applySessionStreamUpdate,
  finishSessionStream,
  pauseSessionStream,
  setSessionStreamError,
  setSessionPagination,
  prependSessionHistory,
  setSessionHistoryLoading,
  trimSessionHistoryWindow,
  setSessionPersistenceState,
  markSessionDirty,
  markSessionPersisted,
  setSessionMainEditorDraft,
  setSessionMainEditorContentTrigger,
  setSessionMainEditorAttachmentsRestore,
  setSessionMergeSettings,
  setSessionGatheringContext,
  setSessionIsInEdit,
  setSessionCodeToEdit,
  updateSessionEditApplyState,
  setSessionReturnToMode,
  setSessionPreviousModeEditorContent,
  updateSessionApplyState,
  resetSessionCodeBlockApplyIndex,
  setCompactionLoadingByMessageId,
  deleteCompactionByMessageId,
  setSessionMode,
  setSessionChatModelTitle,
  setSessionReasoningEnabled,
  setSessionReasoningPreferenceSource,
  setSessionNewestToolbarPreviewForInput,
  setSessionSymbols,
  setSessionInlineError,
  setSessionContextMetrics,
  setSessionScrollState,
} = sessionsSlice.actions;

export default sessionsSlice.reducer;
