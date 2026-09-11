import { useMemo } from "react";
import { useAppSelector } from "../hooks";
import { useSessionId } from "../../components/mainInput/TipTapEditor/SessionScope";
import type { RootState } from "../store";
import type { SessionRuntimeState } from "../slices/sessionsSlice";
import { absoluteToWindowIndex } from "../util/historyIndex";
import {
  selectFullConversationMetricsFreshness,
  selectFullConversationMetricsSnapshot,
  type SessionFullConversationMetricsView,
} from "../thunks/sessionMetrics";
import {
  findGuiIndexContainingMessageId,
  windowItemContainsMessageId,
} from "../util/historyTarget";

/**
 * Phase 4 component migration (方案.md §九).
 *
 * Components read the active session through these selectors instead of
 * `state.session`. Every writer now lives in `sessionsById`, so the runtime is
 * the only source (方案.md §九 Phase 4).
 */

function activeRuntime(state: RootState): SessionRuntimeState | undefined {
  const sessionId = state.sessions.activeSessionId;
  return sessionId ? state.sessions.sessionsById[sessionId] : undefined;
}

/** History of an explicit session (方案.md §九.0). */
export function selectActiveHistoryOf(
  state: RootState,
  sessionId: string,
): SessionRuntimeState["history"] {
  return state.sessions.sessionsById[sessionId]?.history ?? EMPTY_HISTORY;
}

/** Runtime of an explicit session (方案.md §九.0). */
export function activeRuntimeOf(
  state: RootState,
  sessionId: string,
): SessionRuntimeState | undefined {
  return sessionId ? state.sessions.sessionsById[sessionId] : undefined;
}

/** Stable empty values: `useSelector` needs a stable reference. */
const EMPTY_HISTORY: SessionRuntimeState["history"] = [];

/**
 * Explicit-session history for shell consumers that carry a sessionId
 * (方案.md §五.20). Same implementation as `selectActiveHistoryOf`.
 */
export const selectSessionHistory = selectActiveHistoryOf;
const EMPTY_SYMBOLS: SessionRuntimeState["symbols"] = {};
const EMPTY_APPLY_STATES: SessionRuntimeState["codeBlockApplyStates"] = {
  states: [],
  curIndex: 0,
};
const EMPTY_PREVIEWS: SessionRuntimeState["newestToolbarPreviewForInput"] = {};
const EMPTY_CODE_TO_EDIT: SessionRuntimeState["editState"]["codeToEdit"] = [];

export const selectActiveSessionId = (state: RootState): string =>
  state.sessions.activeSessionId ?? "";

export const selectActiveTitle = (state: RootState): string =>
  activeRuntime(state)?.title ?? "";

export const selectActiveHistory = (state: RootState) =>
  activeRuntime(state)?.history ?? EMPTY_HISTORY;

export const selectActiveMode = (state: RootState) =>
  activeRuntime(state)?.mode ?? "chat";

export const selectActiveIsStreaming = (state: RootState): boolean =>
  activeRuntime(state)?.stream.status === "streaming";

export const selectActiveStreamAborter = (state: RootState) =>
  activeRuntime(state)?.stream.aborter;

export const selectActiveIsInEdit = (state: RootState): boolean =>
  activeRuntime(state)?.isInEdit ?? false;

export const selectActiveSymbols = (state: RootState) =>
  activeRuntime(state)?.symbols ?? EMPTY_SYMBOLS;

export const selectActiveCodeBlockApplyStates = (state: RootState) =>
  activeRuntime(state)?.codeBlockApplyStates ?? EMPTY_APPLY_STATES;

export const selectActiveMainEditorDraft = (state: RootState) =>
  activeRuntime(state)?.mainEditorDraft;

export const selectActiveMainEditorContentTrigger = (state: RootState) =>
  activeRuntime(state)?.mainEditorContentTrigger;

export const selectActiveMainEditorAttachmentsRestore = (state: RootState) =>
  activeRuntime(state)?.mainEditorAttachmentsRestore;

export const selectActiveInlineErrorMessage = (state: RootState) =>
  activeRuntime(state)?.inlineErrorMessage;

export const selectActiveFullConversationMetrics = (state: RootState) =>
  activeRuntime(state)?.fullConversationMetrics;

export const selectActiveHasReasoningEnabled = (state: RootState) =>
  activeRuntime(state)?.hasReasoningEnabled;

export const selectActiveDirty = (state: RootState): boolean =>
  activeRuntime(state)?.dirty ?? false;

export const selectActivePendingApprovalCount = (state: RootState): number =>
  activeRuntime(state)?.pendingApprovalCount ?? 0;

export const selectActiveNewestToolbarPreviewForInput = (state: RootState) =>
  activeRuntime(state)?.newestToolbarPreviewForInput ?? EMPTY_PREVIEWS;

export const selectActiveScrollState = (state: RootState) =>
  activeRuntime(state)?.scrollState;

/** Pagination window, preferring the runtime accounting. */
export const selectActiveHistoryTruncated = (state: RootState): boolean =>
  activeRuntime(state)?.pagination.truncated ?? false;

export const selectActiveHistoryLoadedOffset = (state: RootState): number =>
  activeRuntime(state)?.pagination.loadedOffset ?? 0;

export const selectActiveHistoryTotalCount = (state: RootState) =>
  activeRuntime(state)?.pagination.totalCount;

export const selectActiveHasMoreHistory = (state: RootState): boolean =>
  activeRuntime(state)?.pagination.hasMore ?? false;

export const selectActiveIsHistoryLoading = (state: RootState): boolean =>
  activeRuntime(state)?.pagination.loading ?? false;

export const selectActiveLoadedDiskCount = (state: RootState) =>
  activeRuntime(state)?.pagination.loadedDiskCount;

/** Compaction loading is keyed by messageId (方案.md §五.22). */
export const selectActiveCompactionLoading = (
  state: RootState,
  messageId: string | undefined,
): boolean =>
  !!messageId && !!activeRuntime(state)?.compactionLoading[messageId];

/** Edit-mode runtime (方案.md §五.4), per session. */
export const selectActiveCodeToEdit = (state: RootState) =>
  activeRuntime(state)?.editState.codeToEdit ?? EMPTY_CODE_TO_EDIT;

export const selectActiveEditApplyState = (state: RootState) =>
  activeRuntime(state)?.editState.applyState;

export const selectActiveReturnToMode = (state: RootState) =>
  activeRuntime(state)?.editState.returnToMode ?? "chat";

export const selectActiveLastNonEditSessionWasEmpty = (state: RootState) =>
  activeRuntime(state)?.editState.lastNonEditSessionWasEmpty ?? false;

export const selectActivePreviousModeEditorContent = (state: RootState) =>
  activeRuntime(state)?.editState.previousModeEditorContent;

/** Explicit-session variants of the edit-mode selectors (方案.md §五.20). */
export const selectSessionCodeToEdit = (state: RootState, sessionId: string) =>
  activeRuntimeOf(state, sessionId)?.editState.codeToEdit ?? EMPTY_CODE_TO_EDIT;

export const selectSessionEditApplyState = (
  state: RootState,
  sessionId: string,
) => activeRuntimeOf(state, sessionId)?.editState.applyState;

export const selectSessionReturnToMode = (
  state: RootState,
  sessionId: string,
) => activeRuntimeOf(state, sessionId)?.editState.returnToMode ?? "chat";

export const selectSessionLastNonEditSessionWasEmpty = (
  state: RootState,
  sessionId: string,
) =>
  activeRuntimeOf(state, sessionId)?.editState.lastNonEditSessionWasEmpty ??
  false;

export const selectSessionPreviousModeEditorContent = (
  state: RootState,
  sessionId: string,
) => activeRuntimeOf(state, sessionId)?.editState.previousModeEditorContent;

/** Catalog fields (方案.md §五.6), preferring the catalog slice. */
export const selectLastSessionId = (state: RootState): string | undefined =>
  state.sessionCatalog.lastSessionId;

export const selectAllSessionMetadata = (state: RootState) =>
  state.sessionCatalog.allSessionMetadata;

export const selectIsSessionMetadataLoading = (state: RootState): boolean =>
  state.sessionCatalog.isLoading;

// ── Session-scoped hooks (方案.md §九.0) ────────────────────────────────
// Every component inside a <SessionScope> uses these instead of the
// `selectActive*` functions: they read sessionsById[sessionId] for the tree's
// own session and never depend on the global active tab.

export function useSessionRuntime() {
  const sessionId = useSessionId();
  return useAppSelector((state) => activeRuntimeOf(state, sessionId));
}

export function useSessionHistory() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.history ?? EMPTY_HISTORY,
  );
}

export function useSessionIsStreaming(): boolean {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.stream.status === "streaming",
  );
}

export function useSessionMode() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.mode ?? "chat",
  );
}

export function useSessionIsInEdit(): boolean {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.isInEdit ?? false,
  );
}

export function useSessionCodeBlockApplyStates() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) =>
      activeRuntimeOf(state, sessionId)?.codeBlockApplyStates ??
      EMPTY_APPLY_STATES,
  );
}

export function useSessionSymbols() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.symbols ?? EMPTY_SYMBOLS,
  );
}

export function useSessionInlineErrorMessage() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.inlineErrorMessage,
  );
}

/**
 * 方案.md §五.16.6：一个 session 的完整会话指标 + 可信度。组件只读这个投影，
 * 不再读已下线的零散 legacy 字段。
 */
export function useSessionFullConversationMetrics(): SessionFullConversationMetricsView {
  const sessionId = useSessionId();
  // Two stable selections instead of one object-building selector: a selector that
  // returns a fresh object every call would re-render this component on every
  // dispatched action (and re-render it once per stream chunk during a reply).
  const metrics = useAppSelector((state) =>
    selectFullConversationMetricsSnapshot(state, sessionId),
  );
  const freshness = useAppSelector((state) =>
    selectFullConversationMetricsFreshness(state, sessionId),
  );
  return useMemo(() => ({ metrics, freshness }), [metrics, freshness]);
}

export function useSessionEditState() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.editState,
  );
}

/**
 * 方案.md §十一: the synthetic summary separator.
 *
 * The runtime summary is authoritative, but its carrier item may have been
 * trimmed out of the loaded window (lazy history). In that case the boundary is
 * rendered at the head of the window instead of at the carrier's real position.
 *
 * Returns the summary only when the carrier is NOT in the loaded window, so a
 * real carrier and a synthetic separator can never both render.
 */
export function useSessionSyntheticSummary():
  | {
      sourceMessageId: string;
      sourceAbsoluteIndex?: number;
      content: string;
    }
  | undefined {
  const sessionId = useSessionId();
  return useAppSelector((state) => {
    const session = activeRuntimeOf(state, sessionId);
    const summary = session?.latestConversationSummary;
    if (!session || !summary) {
      return undefined;
    }
    const loadedOffset = session.pagination.loadedOffset ?? 0;
    const absoluteIndex = summary.sourceAbsoluteIndex;
    if (absoluteIndex !== undefined) {
      // O(1) check at the carrier's expected position; the id comparison
      // guards against a stale index after an edit or a merge.
      const windowIndex = absoluteToWindowIndex(loadedOffset, absoluteIndex);
      const carrier =
        windowIndex >= 0 && windowIndex < session.history.length
          ? session.history[windowIndex]
          : undefined;
      if (
        carrier &&
        windowItemContainsMessageId(carrier, summary.sourceMessageId)
      ) {
        return undefined;
      }
      // The index may have drifted (bubble merge). Only treat the carrier as
      // trimmed when it really is absent, so a real carrier can never render
      // next to the synthetic separator.
      return findGuiIndexContainingMessageId(
        session.history,
        summary.sourceMessageId,
      ) >= 0
        ? undefined
        : summary;
    }
    // Legacy snapshot without an index: fall back to a scan.
    return findGuiIndexContainingMessageId(
      session.history,
      summary.sourceMessageId,
    ) >= 0
      ? undefined
      : summary;
  });
}

export function useSessionPagination() {
  const sessionId = useSessionId();
  return useAppSelector((state) => {
    const session = activeRuntimeOf(state, sessionId);
    return (
      session?.pagination ?? {
        truncated: false,
        loadedOffset: 0,
        hasMore: false,
        loading: false,
        requestGeneration: 0,
        persistPending: false,
      }
    );
  });
}

export function useSessionPersistence() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.persistence,
  );
}

export function useSessionInterrupted(): boolean {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.interrupted ?? false,
  );
}

export function useSessionPendingApprovalCount(): number {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.pendingApprovalCount ?? 0,
  );
}

export function useSessionMainEditorDraft() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.mainEditorDraft,
  );
}

export function useSessionMainEditorContentTrigger() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.mainEditorContentTrigger,
  );
}

export function useSessionMainEditorAttachmentsRestore() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.mainEditorAttachmentsRestore,
  );
}

export function useSessionNewestToolbarPreviewForInput() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) =>
      activeRuntimeOf(state, sessionId)?.newestToolbarPreviewForInput ??
      EMPTY_PREVIEWS,
  );
}

export function useSessionChatModelTitle() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.chatModelTitle,
  );
}

export function useSessionHasReasoningEnabled() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.hasReasoningEnabled,
  );
}

export function useSessionHistoryTruncated(): boolean {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.pagination.truncated ?? false,
  );
}

export function useSessionHistoryLoadedOffset(): number {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.pagination.loadedOffset ?? 0,
  );
}

export function useSessionHasMoreHistory(): boolean {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.pagination.hasMore ?? false,
  );
}

export function useSessionIsHistoryLoading(): boolean {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.pagination.loading ?? false,
  );
}

export function useSessionCompactionLoading(messageId: string | undefined) {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) =>
      !!messageId &&
      !!activeRuntimeOf(state, sessionId)?.compactionLoading[messageId],
  );
}

export function useSessionScrollState() {
  const sessionId = useSessionId();
  return useAppSelector(
    (state) => activeRuntimeOf(state, sessionId)?.scrollState,
  );
}
