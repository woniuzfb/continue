import { PayloadAction, createSlice } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ApplyState,
  ChatMessage,
  ContextItemWithId,
  FileSymbolMap,
  MessageContent,
  MessageModes,
  RuleMetadata,
  SetCodeToEditPayload,
  ToolCallState,
} from "core";
import type { SessionPersistenceErrorCode } from "core/util/sessionPersistenceError";
import { type InlineErrorMessageType } from "../../components/mainInput/InlineErrorMessage";
import type { AttachmentMeta } from "../../components/mainInput/types";
import { type AttachedFile } from "../../components/mainInput/types";
import type {
  FullConversationMetricsMeta,
  FullConversationMetricsResult,
  FullConversationMetricsSnapshot,
} from "core/util/fullConversationMetrics";
import type { FullConversationMetricsEnvironment } from "../util/fullConversationMetrics";
import {
  ChatHistoryItemWithMessageId,
  SavedMergedProvenance,
  applyStreamUpdatesToHistory,
  mergeSplitReplies,
} from "./sessionHistory";
import { findGuiIndexContainingMessageId } from "../util/historyTarget";

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
  /**
   * 分页簿记字段，**不是磁盘一致性证明**（方案.md §九.6「loadedDiskCount 的
   * 时序语义」）。含义随阶段变化：
   *
   * - loadSessionRuntime / loadPage 后：当前窗口覆盖的 raw disk item 数
   * - prependSessionHistory 后：累加本页 raw page size，仍是未 bubble merge 计数
   * - 成功保存重写磁盘尾部后：**旧值已陈旧**，窗口的磁盘条目数变为 history.length
   * - 保存响应证明映射后：校正为 history.length（即使不 trim 也要校正）
   * - trim 后：retainedDiskItemCount（= keepCount）
   *
   * `loadMoreHistory` 直接把它当作 `history/loadPage` 的 `offset`，因此陈旧值会
   * 跳过条目并在窗口中留下空洞。
   */
  loadedDiskCount?: number;
  hasMore: boolean;
  loading: boolean;
  requestGeneration: number;
  persistPending: boolean;
};

export type SessionStreamState = {
  status: "idle" | "streaming" | "failed";
  requestId?: string;
  aborter?: AbortController;
  error?: string;
  /**
   * Whether the **live request** has already written conversation content
   * (方案.md §五.16.4 step 2). `undefined` means false.
   *
   * `commitSessionConversationTurn` only advances the conversation revision when
   * the turn actually produced content that stays in the conversation: a request
   * that ended before any assistant text / tool call / tool result / preserved
   * partial output (compile failure, stop or provider failure before the first
   * token, no chat model selected) must not move it — the user's own submit
   * already did, and nothing else changed.
   *
   * Lifetime follows the **logical turn**, not one model request: the tool loop
   * starts its next model request while the predecessor is still live
   * (`beginSessionStream` with a live `requestId`), and the terminal of that
   * continuation is the one that commits the whole turn. So the rule is exactly
   * "a request that starts with no live predecessor starts from false", and
   * `finishSessionStream` drops the arming with the request that owned it.
   */
  hasConversationMutation?: boolean;
};

/** Persistence defaults shared by the reducers below (方案.md §七.1). */
function initialPersistenceState(): SessionPersistenceState {
  return {
    state: "clean",
    revision: 0,
    persistedRevision: 0,
    hasPersistedBaseline: false,
  };
}

/**
 * Per-session state of the legacy message-ID migration (P4a, 方案.md §九.13).
 *
 * Runtime-only: this describes a maintenance side effect on the **disk** file,
 * never the conversation. Writing it must not touch `dirty`, `conversationRevision`,
 * `persistence.revision`, `history` or `fullConversationMetrics` — a migration
 * changes
 * nothing about the request history, so it must not invalidate the metrics
 * snapshot or make the session look modified.
 *
 * `unsupported` and `failed/REQUEST_TIMEOUT` are different facts and are kept
 * apart on purpose:
 *   unsupported          → the host never declared the capability, so nothing
 *                          was ever sent (no request, no leaked listener).
 *   failed/REQUEST_TIMEOUT → the host declared it but did not answer in time.
 * Folding the second into the first would report a transient host stall as a
 * permanent property of the host.
 */
export type MessageIdMigrationState =
  | { state: "not-requested" }
  | { state: "pending" }
  | {
      state: "succeeded";
      /** False when the file already had every id: a success no-op. */
      migrated: boolean;
      addedCount: number;
    }
  | {
      state: "failed";
      code:
        | "SESSION_FILE_INVALID"
        | "MESSAGE_ID_MIGRATION_FAILED"
        | "REQUEST_TIMEOUT";
      message: string;
    }
  | { state: "unsupported" };

export type SessionRuntimeState = {
  id: string;
  title: string;

  history: ChatHistoryItemWithMessageId[];
  /** Bumped by every request-relevant mutation; gates metrics recomputation. */
  conversationRevision: number;
  firstTurnItems: ChatHistoryItemWithMessageId[];
  latestConversationSummary?: {
    sourceMessageId: string;
    /** Absolute index in the full history (方案.md §十一 synthetic separator). */
    sourceAbsoluteIndex?: number;
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

  /**
   * 完整逻辑会话指标 + 快照身份（方案.md §五.16.5）。runtime-only，独立于
   * Local Provider 的缩减发送载荷；trim / prepend / bubble merge / 保存状态
   * 变化都不得改变它们。
   */
  fullConversationMetrics?: FullConversationMetricsSnapshot;
  fullConversationMetricsMeta?: FullConversationMetricsMeta;
  /**
   * 快照被接受时的构造环境指纹（方案.md §五.16.6）—— fresh 判定用它做 O(1) 比较，
   * 不在渲染路径重算 canonical identity。undefined ⇒ 无法证明 fresh ⇒ stale。
   */
  fullConversationMetricsEnvironment?: FullConversationMetricsEnvironment;
  /**
   * 该 session 正在为一次**尚未提交**的发送解析上下文（方案.md §五.20）。
   * runtime-only：不进 history、不进保存、不进指标。
   */
  isGatheringContext?: boolean;
  /**
   * 展示用的 pending 草稿（工作流 "submit latency and retry boundary" 第 3 步）。
   *
   * Stage 2F 之后气泡要等内容解析完才提交，于是用户在 ~1 秒里看不到任何反馈。这份草稿
   * **只是展示**：不进 history、不进保存载荷、不进完整会话指标与 construction identity、
   * 不参与 trim / paging / 请求构造，也**不推进** `conversationRevision`。
   */
  pendingSubmission?: PendingSubmission;
  /**
   * 正在飞行的只读计量请求数（方案.md §五.16.6 的 `measuring` 态）。用计数而不是布尔：
   * 同一 session 可能有并发请求（例如激活门禁与手动重算），布尔会让先返回的那个提前清掉
   * 后一个仍在飞行的状态。
   */
  fullConversationMetricsMeasuring?: number;

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
  /** Legacy message-ID migration progress on the disk file (P4a). */
  messageIdMigration: MessageIdMigrationState;

  pendingApprovalCount: number;
  /**
   * The loaded history contains a turn that cannot be resumed (a restart lost
   * its request/aborter/tool context). 方案.md §八 interrupted semantics.
   */
  interrupted?: boolean;
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
    conversationRevision: 0,
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
    messageIdMigration: { state: "not-requested" },
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

/**
 * Every mutation that changes the request history (messages, context items,
 * applied rules, summary, mode) marks the session dirty and advances
 * `conversationRevision`, which is what the metrics recompute gate compares.
 */
/**
 * Every request-relevant content mutation bumps `conversationRevision` (metrics
 * staleness) *and* `persistence.revision` (save staleness, 方案.md §七.3/§七.6).
 *
 * The persistence counter used to move only on submit/title, so a save that
 * completed after a compact/delete/edit still compared as "current": it marked
 * the session clean although newer content was queued, and its response could
 * overwrite the newer derived metadata.
 */
/**
 * 方案.md §七.7: a failed save stays `failed` (with its error) until an explicit
 * retry succeeds. New content must not turn it into `pending` — that would hide
 * the retry banner/badge and re-enable the gates that key on `failed`.
 *
 * clean → pending, pending → pending, saving → saving, failed → failed.
 */
function stateAfterMutation(
  current: SessionPersistenceState["state"],
): SessionPersistenceState["state"] {
  switch (current) {
    case "failed":
      return "failed";
    case "saving":
      return "saving";
    default:
      return "pending";
  }
}

/**
 * Content must be re-saved, but the full-conversation semantics did not change
 * (方案.md §五.16.2): stream chunks, promptLog/reasoning bookkeeping. Advances
 * the save revision only — never the conversation revision, so the context
 * metrics snapshot stays fresh.
 */
function markPersistenceChanged(session: SessionRuntimeState): void {
  session.dirty = true;
  const persistence = session.persistence ?? initialPersistenceState();
  session.persistence = {
    ...persistence,
    state: stateAfterMutation(persistence.state),
    revision: persistence.revision + 1,
  };
}

function markHistoryChanged(session: SessionRuntimeState): void {
  markPersistenceChanged(session);
  session.conversationRevision += 1;
}

/**
 * Drops the freshness identity of the metrics snapshot while keeping its
 * last-known VALUE visible (方案.md §五.16): the ring must not blank just because
 * the conversation moved on, and a consumer decides freshness by comparing the
 * identity (missing identity = stale, recompute when the gate allows).
 */
function markFullConversationMetricsStale(session: SessionRuntimeState): void {
  session.fullConversationMetricsMeta = undefined;
  // The environment stamp describes the snapshot the meta belonged to; a stale
  // snapshot has no provable environment, so it is dropped together with the meta.
  session.fullConversationMetricsEnvironment = undefined;
}

/**
 * A send that is still being prepared: the user's text is already known (the editor
 * content is available synchronously) but the turn cannot be committed until context
 * resolution finishes.
 *
 * Presentation-only. It exists so the bubble appears in the same tick as Enter instead of
 * after the context IPC (see `submitSessionInput`), and it is deliberately not a history
 * item: every consumer of real content (save payload, metrics, identity, paging, trim,
 * request building) must stay blind to it.
 */
export type PendingSubmission = {
  /**
   * Matches a specific attempt. Cleanup is ID-checked so a stale failure cannot clear a
   * newer draft.
   */
  submissionId: string;
  /**
   * `resolving-context`: the turn does not exist yet, so the draft row is what the user sees.
   *
   * `committed-awaiting-stream`: the turn **is** committed and rendered, but `beginSessionStream`
   * has not run yet. The committed bubble must keep the animated border through this window
   * instead of falling back to the static history style — with the hydration moved after the
   * commit that window is ~230ms (seconds when the disk read is slow), and it showed up as
   * "static bubble first, coloured bubble a moment later".
   */
  status: "resolving-context" | "committed-awaiting-stream";
  /** Set once the turn is committed; the message the animated border belongs to. */
  committedUserMessageId?: string;
  /** Where the committed turn will land — the draft renders in that same place. */
  insertion: { kind: "append" } | { kind: "replace"; targetMessageId: string };
  /** The text to show, taken synchronously from the editor. */
  displayContent: MessageContent;
  /** Attachment chips (metadata only — never the file contents). */
  attachmentMeta?: AttachmentMeta[];
  /** For the elapsed indicator; the draft is never persisted, so wall clock is fine. */
  startedAt: number;
};

/**
 * Where a submitted turn lands (方案.md §七.3, Stage 2F 收口).
 *
 * An index captured **before** the async half of the send (context providers, slash
 * commands) cannot be trusted afterwards: the window may have been hydrated, trimmed,
 * or appended to, so the same number can address a different turn. The intent is
 * therefore expressed as a discriminated identity, and `expectedConversationRevision`
 * is the atomic guard that a submit prepared against content that is still current.
 *
 * ```text
 * append           ⇒ 提交到**当时**的尾部（history.length 在 reducer 内读）
 * replace(identity) ⇒ 按 message id（含 bubble provenance）重新定位目标
 * ```
 *
 * 两者都对不上时 reducer **什么都不做**：既不改写别的回合，也不静默降级为追加。
 */
export type SubmittedTurnInsertion =
  | { kind: "append"; expectedConversationRevision: number }
  | {
      kind: "replace";
      targetMessageId: string;
      expectedConversationRevision: number;
    };

/**
 * Re-point (or drop) the compaction summary after a submitted turn replaced the
 * tail of the conversation (方案.md §五.16.1, Stage 2F).
 *
 * A resend can truncate the summary's carrier item away, or shift its index. Both
 * belong to the **same** mutation as the submitted turn, so they must not advance
 * the content revision a second time — the standalone
 * `setSessionConversationSummary` / `clearSessionConversationSummary` actions do
 * advance it, which is why submit folds the reindex into its single boundary.
 */
function reindexSummaryAfterSubmittedTurn(session: SessionRuntimeState): void {
  const summary = session.latestConversationSummary;
  if (!summary) {
    return;
  }
  const index = session.history.findIndex(
    (item) =>
      item.message.id === summary.sourceMessageId &&
      item.conversationSummary === summary.content,
  );
  if (index < 0) {
    session.latestConversationSummary = undefined;
    return;
  }
  if (index !== summary.sourceAbsoluteIndex) {
    session.latestConversationSummary = {
      ...summary,
      sourceAbsoluteIndex: index,
    };
  }
}

/**
 * Terminal commit (方案.md §五.16.4): the assistant turn is final, so
 * `conversationRevision` advances exactly once — the individual chunks and the
 * tool writes inside the turn only advanced the persistence revision.
 */
function markConversationCommitted(session: SessionRuntimeState): void {
  session.conversationRevision += 1;
  markFullConversationMetricsStale(session);
}

/**
 * Arms the terminal commit of the live chat request (方案.md §五.16.4 step 2).
 * Called from every write point that puts conversation content into the GUI
 * history while a request is live. A session with no live request has no turn to
 * commit, so nothing is recorded.
 */
function noteStreamConversationMutation(session: SessionRuntimeState): void {
  if (session.stream.requestId !== undefined) {
    session.stream.hasConversationMutation = true;
  }
}

/**
 * Keys of `history[n]` whose update changes the full logical conversation and
 * therefore the conversation metrics (方案.md §五.16). Everything else —
 * promptLogs, reasoning display flags, `appliedRules` (per-message display
 * metadata; `constructMessages` derives the applied rules from config, not from
 * the item) and editorState — is runtime bookkeeping: it must be saved, but
 * must not invalidate the snapshot.
 */
const CONVERSATION_RELEVANT_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "message",
  "contextItems",
  "conversationSummary",
  "toolCallStates",
]);

function updateChangesConversation(
  updates: Partial<ChatHistoryItemWithMessageId>,
): boolean {
  return Object.keys(updates).some((key) =>
    CONVERSATION_RELEVANT_UPDATE_KEYS.has(key),
  );
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
        /**
         * 方案.md §五.19: closing an *inactive* tab must not move the visible
         * tab. Only the close of the active tab computes and activates a
         * replacement (right neighbour → left neighbour → new empty tab).
         */
        wasActive: boolean;
        replacementSessionId?: string;
        newEmptySession?: SessionRuntimeState;
      }>,
    ) => {
      const { sessionId, wasActive, replacementSessionId, newEmptySession } =
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

      if (!wasActive) {
        return;
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
    /**
     * Whole-array replacement with **two different meanings** (方案.md §七.3),
     * which the caller must now state explicitly:
     *
     * - `origin: "hydration"` (loadFullHistory / disk merge): the window is
     *   replaced by the authoritative disk content of the *same* logical
     *   conversation, so it must NOT mark the session dirty and must NOT advance
     *   the content revision (方案.md §五.16.1: hydration / paging must not);
     * - `origin: "content"`: the caller replaces the window with **new** content
     *   in one write, so the caller must immediately `markSessionDirty`
     *   (persistence.revision) and this write is a new content version. A submitted
     *   turn does **not** use this path since Stage 2F — it is an insert, not a
     *   whole-array replacement, and it owns its boundary through
     *   `commitSubmittedTurn` (方案.md §五.16.1).
     */
    setSessionHistory: (
      state,
      action: PayloadAction<{
        sessionId: string;
        history: ChatHistoryItemWithMessageId[];
        origin: "hydration" | "content";
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.history = action.payload.history;
        if (action.payload.origin === "content") {
          session.conversationRevision += 1;
          markFullConversationMetricsStale(session);
        }
      }
    },
    /**
     * A submitted turn is **one atomic conversation mutation** (方案.md §五.16.1/§七.3,
     * Stage 2F).
     *
     * The user item becomes visible with its complete content, context items and
     * attachments *together with* the assistant placeholder, and
     * `conversationRevision` advances exactly once. Splitting this into "create the
     * structure" + "fill the content" used to advance the revision twice and left an
     * observable window in which history held an empty user message next to the
     * placeholder — a window any save (unload flush, a targeted mode/model save)
     * could have persisted, and any measurement would have described a conversation
     * that never existed.
     *
     * The target is an **identity**, not an index (see `SubmittedTurnInsertion`), and
     * the whole thing is refused atomically when the conversation moved on while the
     * editor content was being resolved — including the case where the target message
     * no longer exists. A stale submit must never rewrite another turn, and it must
     * never silently degrade into an append.
     */
    commitSubmittedTurn: (
      state,
      action: PayloadAction<{
        sessionId: string;
        userItem: ChatHistoryItemWithMessageId;
        assistantPlaceholder: ChatHistoryItemWithMessageId;
        insertion: SubmittedTurnInsertion;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const { userItem, assistantPlaceholder, insertion } = action.payload;
      if (
        session.conversationRevision !== insertion.expectedConversationRevision
      ) {
        return;
      }
      let insertionPoint: number;
      if (insertion.kind === "append") {
        // The size is read *now*: a window that grew while the content was being
        // resolved must still receive an append, not a truncated tail.
        insertionPoint = session.history.length;
      } else {
        insertionPoint = findGuiIndexContainingMessageId(
          session.history,
          insertion.targetMessageId,
        );
        if (insertionPoint < 0) {
          return;
        }
      }
      const replaces = insertionPoint < session.history.length;
      session.history = replaces
        ? [
            ...session.history.slice(0, insertionPoint),
            userItem,
            assistantPlaceholder,
          ]
        : [...session.history, userItem, assistantPlaceholder];
      reindexSummaryAfterSubmittedTurn(session);
      // One boundary for the whole submit: persistence dirty + exactly one content
      // version, with the metrics snapshot's freshness dropped (its value stays).
      markHistoryChanged(session);
      markFullConversationMetricsStale(session);
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
      if (updateChangesConversation(action.payload.updates)) {
        if (session.stream.requestId !== undefined) {
          // 方案.md §五.16.4: inside a live logical turn the terminal commit is
          // the ONLY conversation-revision boundary. Tool call / tool result
          // writes reach history through this reducer, so they must only mark
          // the content for saving and arm that commit — advancing the revision
          // here as well would count the same logical change twice.
          markPersistenceChanged(session);
          noteStreamConversationMutation(session);
        } else {
          // Out of stream (user edit / compact / delete / hydration): this write
          // is a complete content version by itself — no terminal will follow.
          markHistoryChanged(session);
        }
        // Content changed, so the snapshot is no longer fresh — but its value is
        // still the last-known one and stays displayed (方案.md §五.16).
        markFullConversationMetricsStale(session);
      } else {
        // promptLogs / reasoning / editorState bookkeeping: must be saved, but
        // must NOT invalidate the context metrics — otherwise the ring drops to
        // zero the moment a reply finishes (方案.md §五.16.2).
        markPersistenceChanged(session);
      }
      Object.assign(item, action.payload.updates);
      // 方案.md §十一: the runtime summary is what the Local Provider sends, so a
      // compact result must be visible immediately instead of only after the
      // save response returns.
      if (action.payload.updates.conversationSummary !== undefined) {
        const index = session.history.indexOf(item);
        session.latestConversationSummary = {
          sourceMessageId: action.payload.messageId,
          sourceAbsoluteIndex: index,
          content: action.payload.updates.conversationSummary,
        };
      }
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
        // appliedRules is per-message display metadata; `constructMessages`
        // derives the applied rules from config, not from the item. It must be
        // saved but must not advance the conversation revision (方案.md §五.16).
        markPersistenceChanged(session);
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
      // 方案.md §五.16: the snapshot's VALUE is the last-known one and stays
      // visible; only its freshness identity is dropped.
      markFullConversationMetricsStale(session);
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
      // 方案.md §五.16: the snapshot's VALUE is the last-known one and stays
      // visible; only its freshness identity is dropped.
      markFullConversationMetricsStale(session);
      session.pendingApprovalCount = 0;
    },

    // ── First turn / Summary ──────────────────────────────────────────────
    /**
     * `firstTurnItems` is a **derived cache of the disk head**: Core echoes it
     * back on every successful save, and the load paths rebuild it from the
     * history they just read. It only feeds the Local Provider's reduced send
     * payload — the full-conversation metrics are built from the full history —
     * and every change of its source (history edit, compact, delete, hydration)
     * advances the conversation revision by itself. Hydration / save echo must
     * therefore never advance it (方案.md §五.16.1 / 已知限制 #64).
     */
    setSessionFirstTurn: (
      state,
      action: PayloadAction<{
        sessionId: string;
        firstTurnItems: ChatHistoryItemWithMessageId[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        // 方案.md §五.16.1: 首轮是磁盘头部的派生缓存，只服务 Local Provider 的
        // 缩减发送载荷；完整会话 metrics 以完整 history 构造，因此 hydration /
        // 保存回灌都**不拥有**内容版本（真正的内容变化由 edit/delete/compact
        // 等 action 自己推进）。响应仍是权威值，直接写入。
        session.firstTurnItems = action.payload.firstTurnItems;
      }
    },
    setSessionConversationSummary: (
      state,
      action: PayloadAction<{
        sessionId: string;
        summary: {
          sourceMessageId: string;
          sourceAbsoluteIndex?: number;
          content: string;
        };
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const { summary } = action.payload;
      const previous = session.latestConversationSummary;
      // The save response carries the same summary back on every save; only a
      // real change is a new version of the conversation content (方案.md
      // §五.16.1). Assigning an equal-value object would also churn the
      // reference every save.
      const changed =
        previous?.sourceMessageId !== summary.sourceMessageId ||
        previous?.sourceAbsoluteIndex !== summary.sourceAbsoluteIndex ||
        previous?.content !== summary.content;
      if (!changed) {
        return;
      }
      session.latestConversationSummary = summary;
      session.conversationRevision += 1;
    },
    clearSessionConversationSummary: (
      state,
      action: PayloadAction<{ sessionId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      // A save without a compaction omits the summary on **every** save; there is
      // nothing to clear by then, and a write that changes nothing must not
      // advance the content revision (方案.md §五.16.1).
      if (session && session.latestConversationSummary !== undefined) {
        session.latestConversationSummary = undefined;
        session.conversationRevision += 1;
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
        // A continuation (the tool loop's next model request) starts while the
        // predecessor request is still live and belongs to the same logical
        // turn, so what the turn already wrote must still be committed by that
        // continuation's terminal. A fresh turn starts with no output.
        const isContinuation = session.stream.requestId !== undefined;
        const hasConversationMutation = isContinuation
          ? (session.stream.hasConversationMutation ?? false)
          : false;
        session.stream = {
          status: "streaming",
          requestId: action.payload.requestId,
          aborter: action.payload.aborter,
          hasConversationMutation,
        };
        // The awaiting-stream window ends here: from now on `isStreaming` is what keeps the
        // animated border on the submitted bubble, so the presentation-only pending state is
        // dropped. No id check is needed — a second send is refused while one is pending, so
        // the pending state can only belong to this request.
        delete session.pendingSubmission;
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
      // 方案.md §五.16.2: a chunk is content that must be saved, but it does not
      // advance the conversation revision — the terminal commit does that once.
      markPersistenceChanged(session);
      // Compile-metadata-only chunks are not conversation content and do not arm
      // the terminal commit (方案.md §五.16.4 step 2).
      if (applyStreamUpdatesToHistory(session, action.payload.messages)) {
        noteStreamConversationMutation(session);
      }
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
        // The turn is still live: whatever it already wrote is still committed
        // by this request's terminal (方案.md §五.16.4 step 2).
        hasConversationMutation:
          session.stream.hasConversationMutation ?? false,
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
      // The request ends here, so the terminal commit's arming ends with it.
      session.stream = {
        status: action.payload.status === "completed" ? "idle" : "failed",
        // Terminal failure keeps its error metadata for the recovery entry
        // (方案.md §七.4); the requestId itself is released.
        ...(action.payload.status === "failed" && error ? { error } : {}),
      };
    },
    /**
     * Chat terminal commit (方案.md §五.16.4). Only the CHAT stream's final turn
     * advances the conversation revision and drops the metrics freshness
     * identity. Non-chat streams (e.g. edit mode) end through
     * `finishSessionStream` alone and must not invalidate the metrics.
     */
    commitSessionConversationTurn: (
      state,
      action: PayloadAction<{
        sessionId: string;
        requestId: string;
        terminalStatus: "completed" | "aborted" | "failed";
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session || session.stream.requestId !== action.payload.requestId) {
        return;
      }
      // 方案.md §五.16.4 step 2: a completed logical turn is one whose output
      // actually reached the GUI history. A request that ended before writing
      // anything (out-of-context compile, stop or provider failure before the
      // first token, no chat model selected) must not advance the revision the
      // user's submit already advanced.
      if (!session.stream.hasConversationMutation) {
        return;
      }
      markConversationCommitted(session);
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
        // A failure after partial output still formed a turn that must commit.
        hasConversationMutation:
          session.stream.hasConversationMutation ?? false,
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
      // 方案.md §五.16.1: prepending older history changes the WINDOW, not the
      // logical conversation (the metrics measure the full history), so it must
      // not advance the content revision.
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
        // 方案.md §五.16.1: trim 改变的是窗口，不是完整逻辑会话内容。
        session.history = session.history.slice(
          session.history.length - keepCount,
        );
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
    /**
     * LazyLoad_merge_provenance_设计.md §2.3: provenance means "this merged item has
     * not been written to disk in this shape yet", so it is dropped as soon as a
     * save containing it succeeded.
     *
     * Deliberately **not** gated on `persistence.revision`, and the caller
     * dispatches it after **any** successful save: the question here is per-item
     * ("is the current item still exactly what was just written?") rather than
     * session-wide ("is this response the current revision?"). A save in flight
     * can see ordinary content changes — a new user message, a stream chunk —
     * that bump the revision while leaving this merged item untouched; its
     * provenance must still be cleared, otherwise a later compact/delete would
     * resolve the carrier to a raw id that no longer exists on disk.
     *
     * Matching is by id **and** the ordered member list: the id alone is not a
     * complete fingerprint of the saved shape. Comparing ids only would treat any
     * runtime state that reuses the id as "already written", so the comparison is
     * deliberately the conservative superset — a mismatch keeps the provenance,
     * which is always the safe direction (the fallback is an explicit abort, never
     * a wrong write).
     *
     * Pure: never marks dirty, never advances `conversationRevision` or
     * `persistence.revision`, and leaves the `history` array reference untouched
     * when no fingerprint matches.
     */
    clearSavedMergedReplyProvenance: (
      state,
      action: PayloadAction<{
        sessionId: string;
        savedMergedProvenance: SavedMergedProvenance[];
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      const saved = action.payload.savedMergedProvenance;
      if (!session || saved.length === 0) {
        return;
      }

      let changed = false;
      const nextHistory = session.history.map((item) => {
        const provenance = item.mergedReplyProvenance;
        if (!provenance) {
          return item;
        }
        const isStillTheSavedShape = saved.some(
          (fingerprint) =>
            fingerprint.mergedItemMessageId === item.message.id &&
            fingerprint.sourceMessageIds.length ===
              provenance.sourceMessageIds.length &&
            fingerprint.sourceMessageIds.every(
              (id, index) => id === provenance.sourceMessageIds[index],
            ),
        );
        if (!isStillTheSavedShape) {
          return item;
        }
        changed = true;
        const { mergedReplyProvenance: _dropped, ...rest } = item;
        return rest as ChatHistoryItemWithMessageId;
      });

      // Only replace the array when something was actually dropped: an
      // unconditional assignment would invalidate every memoised StepContainer.
      if (changed) {
        session.history = nextHistory;
      }
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
     * 方案.md §七.5/§七.7: async save results must update the *current*
     * persistence incrementally. Writing a snapshot captured before the await
     * would roll `revision` back to the value it had when the request started,
     * discarding changes that arrived while the save was in flight.
     */
    markSessionSaving: (
      state,
      action: PayloadAction<{ sessionId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const persistence = session.persistence ?? initialPersistenceState();
      session.persistence = { ...persistence, state: "saving" };
    },
    markSessionSaveFailed: (
      state,
      action: PayloadAction<{
        sessionId: string;
        error: NonNullable<SessionPersistenceState["error"]>;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const persistence = session.persistence ?? initialPersistenceState();
      // revision / persistedRevision / hasPersistedBaseline come from the
      // current state, never from the request that failed.
      session.persistence = {
        ...persistence,
        state: "failed",
        error: action.payload.error,
      };
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
      const persistence = session.persistence ?? initialPersistenceState();
      session.persistence = {
        ...persistence,
        state: stateAfterMutation(persistence.state),
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

    /**
     * P4a: record the legacy message-ID migration state for one session.
     *
     * This reducer touches exactly one field. It must never mark the session
     * dirty, advance `conversationRevision`, move `persistence.revision` or clear
     * `fullConversationMetrics` / `fullConversationMetricsMeta`: the migration rewrites
     * `message.id` on disk only — content, order, roles, first turn, summary and
     * the request history are unchanged, so the metrics snapshot is still
     * valid and its circle must neither flash nor recompute.
     */
    setMessageIdMigrationState: (
      state,
      action: PayloadAction<{
        sessionId: string;
        migration: MessageIdMigrationState;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.messageIdMigration = action.payload.migration;
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
     * C3 (方案.md §五.17): project `config.ui`'s merge settings onto **every
     * loaded runtime** in one transaction. `config.ui` is the authority; these
     * two fields are only the reducer-readable mirror, so a config change must
     * never leave a hidden session on a stale value.
     *
     * Pure runtime write: no dirty, no `conversationRevision` /
     * `persistence.revision` bump, no save, no IPC, no runtime creation, and no
     * change to `activeSessionId` / descriptors.
     */
    setAllSessionMergeSettings: (
      state,
      action: PayloadAction<{
        dontMergeReplyBubbles?: boolean;
        dontMergeHistoricalReplyBubbles?: boolean;
      }>,
    ) => {
      for (const session of Object.values(state.sessionsById)) {
        if (action.payload.dontMergeReplyBubbles !== undefined) {
          session.dontMergeReplyBubbles = action.payload.dontMergeReplyBubbles;
        }
        if (action.payload.dontMergeHistoricalReplyBubbles !== undefined) {
          session.dontMergeHistoricalReplyBubbles =
            action.payload.dontMergeHistoricalReplyBubbles;
        }
      }
    },
    /**
     * 方案.md §五.20 / "submit latency and retry boundary": is this session resolving
     * context for a send that has not been committed yet?
     *
     * This is a **session** flag, not a history-item flag. It used to write
     * `history.at(-1).isGatheringContext`, which required the assistant placeholder to
     * already be in history — Stage 2F commits the submitted turn *after* the content is
     * resolved, so the flag landed on the previous turn (or nowhere at all in a fresh
     * session). The state belongs to the session because during resolution there is no
     * submitted turn to attach it to.
     */
    /**
     * Shows the pending draft for a send that is still being prepared (see
     * `PendingSubmission`). Purely presentational: no revision, no dirty, no history.
     */
    setPendingSubmission: (
      state,
      action: PayloadAction<{
        sessionId: string;
        submission: PendingSubmission;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.pendingSubmission = action.payload.submission;
      }
    },
    /**
     * The turn is committed but the model request has not started: stop rendering the draft
     * row (the real bubble is there now) while keeping the presentation state, which
     * `ContinueInputBox` reads to keep the animated border on that specific message.
     */
    markPendingSubmissionCommitted: (
      state,
      action: PayloadAction<{
        sessionId: string;
        submissionId: string;
        committedUserMessageId: string;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      const pending = session?.pendingSubmission;
      if (!session || !pending) {
        return;
      }
      if (pending.submissionId !== action.payload.submissionId) {
        return;
      }
      session.pendingSubmission = {
        ...pending,
        status: "committed-awaiting-stream",
        committedUserMessageId: action.payload.committedUserMessageId,
      };
    },
    /**
     * Clears the draft — **only** when the id matches, so a slow failing attempt cannot
     * remove the draft of a newer one.
     */
    clearPendingSubmission: (
      state,
      action: PayloadAction<{ sessionId: string; submissionId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (
        session?.pendingSubmission?.submissionId === action.payload.submissionId
      ) {
        delete session.pendingSubmission;
      }
    },
    setSessionGatheringContext: (
      state,
      action: PayloadAction<{ sessionId: string; gathering: boolean }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      if (action.payload.gathering) {
        session.isGatheringContext = true;
      } else {
        delete session.isGatheringContext;
      }
    },
    setSessionInterrupted: (
      state,
      action: PayloadAction<{ sessionId: string; interrupted: boolean }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.interrupted = action.payload.interrupted;
      }
    },
    setSessionLastNonEditSessionWasEmpty: (
      state,
      action: PayloadAction<{ sessionId: string; isEmpty: boolean }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.editState.lastNonEditSessionWasEmpty = action.payload.isEmpty;
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
        // Deleting the carrier must stop the summary from being sent before
        // the authoritative save response arrives (方案.md §十一).
        if (
          session.latestConversationSummary?.sourceMessageId ===
          action.payload.messageId
        ) {
          session.latestConversationSummary = undefined;
        }
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
        // 方案.md §五.16.1/§五.16.2: mode 只改变 constructionIdentity（由门禁
        // 比较后触发重算），不是新的内容版本。
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
      action: PayloadAction<{
        sessionId: string;
        enabled?: boolean;
        /**
         * 方案.md §七.8: where this value came from. A "derived" update (config
         * load / model switch) must not silently overwrite an explicit user
         * choice, which is the value that gets persisted.
         */
        source?: "derived" | "explicit";
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.hasReasoningEnabled = action.payload.enabled;
        const { source } = action.payload;
        if (
          source &&
          !(
            source === "derived" &&
            session.reasoningPreferenceSource === "explicit"
          )
        ) {
          session.reasoningPreferenceSource = source;
        }
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
    /**
     * Accepts an already-validated full-conversation metrics result
     * (方案.md §五.16.5). The thunk owns the expensive validation (complete
     * identity: revision + construction identity + schema); the reducer repeats
     * the cheap one — the snapshot may only describe the conversation revision
     * the session is on right now, otherwise the freshness identity would claim
     * more than it can prove.
     *
     * The caller also passes the **construction environment stamp** it validated
     * against (方案.md §五.16.6): freshness is then an O(1) comparison instead of a
     * per-render canonical identity recompute.
     */
    setSessionFullConversationMetrics: (
      state,
      action: PayloadAction<{
        sessionId: string;
        result: FullConversationMetricsResult;
        environment: FullConversationMetricsEnvironment;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const { result, environment } = action.payload;
      if (result.meta.conversationRevision !== session.conversationRevision) {
        return;
      }
      session.fullConversationMetrics = result.metrics;
      session.fullConversationMetricsMeta = result.meta;
      session.fullConversationMetricsEnvironment = environment;
    },
    /**
     * 门禁证明「快照身份仍等于当前构造身份」时，把环境指纹刷新成当前环境
     * （方案.md §五.16.6）。指纹是**保守近似**：引用换了但内容逐字没变时会多报 stale，
     * 而 stale 永久留着会让「只吃 fresh」的消费者无谓停摆。刷新只在门禁真的比过
     * canonical identity 之后发生，因此不会把陈旧快照洗成 fresh。
     */
    refreshSessionFullConversationMetricsEnvironment: (
      state,
      action: PayloadAction<{
        sessionId: string;
        environment: FullConversationMetricsEnvironment;
      }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (
        session &&
        session.fullConversationMetrics &&
        session.fullConversationMetricsMeta
      ) {
        session.fullConversationMetricsEnvironment = action.payload.environment;
      }
    },
    /**
     * 方案.md §五.16.6 `measuring` 态：只读计量在飞行中。这不是「旧值」也不是
     * 「新值」，因此消费者（尤其自动决策）不得把它当作 fresh。
     */
    beginSessionFullConversationMetricsMeasure: (
      state,
      action: PayloadAction<{ sessionId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (session) {
        session.fullConversationMetricsMeasuring =
          (session.fullConversationMetricsMeasuring ?? 0) + 1;
      }
    },
    endSessionFullConversationMetricsMeasure: (
      state,
      action: PayloadAction<{ sessionId: string }>,
    ) => {
      const session = findRuntime(state, action.payload.sessionId);
      if (!session) {
        return;
      }
      const remaining = (session.fullConversationMetricsMeasuring ?? 0) - 1;
      if (remaining > 0) {
        session.fullConversationMetricsMeasuring = remaining;
      } else {
        delete session.fullConversationMetricsMeasuring;
      }
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
  commitSessionConversationTurn,
  pauseSessionStream,
  setSessionStreamError,
  setSessionPagination,
  prependSessionHistory,
  setSessionHistoryLoading,
  trimSessionHistoryWindow,
  clearSavedMergedReplyProvenance,
  markSessionSaveFailed,
  markSessionSaving,
  setSessionPersistenceState,
  markSessionDirty,
  markSessionPersisted,
  setMessageIdMigrationState,
  setSessionMainEditorDraft,
  setSessionMainEditorContentTrigger,
  setSessionMainEditorAttachmentsRestore,
  setSessionInterrupted,
  setSessionLastNonEditSessionWasEmpty,
  setAllSessionMergeSettings,
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
  commitSubmittedTurn,
  setPendingSubmission,
  markPendingSubmissionCommitted,
  clearPendingSubmission,
  setSessionFullConversationMetrics,
  refreshSessionFullConversationMetricsEnvironment,
  beginSessionFullConversationMetricsMeasure,
  endSessionFullConversationMetricsMeasure,
  setSessionScrollState,
} = sessionsSlice.actions;

export default sessionsSlice.reducer;
