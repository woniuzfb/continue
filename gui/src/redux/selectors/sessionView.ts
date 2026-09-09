import type { RootState } from "../store";
import type { SessionRuntimeState } from "../slices/sessionsSlice";

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

/** Stable empty values: `useSelector` needs a stable reference. */
const EMPTY_HISTORY: SessionRuntimeState["history"] = [];
const EMPTY_SYMBOLS: SessionRuntimeState["symbols"] = {};
const EMPTY_APPLY_STATES: SessionRuntimeState["codeBlockApplyStates"] = {
  states: [],
  curIndex: 0,
};
const EMPTY_PREVIEWS: SessionRuntimeState["newestToolbarPreviewForInput"] = {};

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

export const selectActiveIsPruned = (state: RootState) =>
  activeRuntime(state)?.isPruned;

export const selectActiveContextPercentage = (state: RootState) =>
  activeRuntime(state)?.contextPercentage;

export const selectActiveContextInputTokens = (state: RootState) =>
  activeRuntime(state)?.contextInputTokens;

export const selectActiveContextLength = (state: RootState) =>
  activeRuntime(state)?.contextLength;

export const selectActiveContextMetrics = (state: RootState) =>
  activeRuntime(state)?.contextMetrics;

export const selectActiveHasReasoningEnabled = (state: RootState) =>
  activeRuntime(state)?.hasReasoningEnabled;

export const selectActiveDirty = (state: RootState): boolean =>
  activeRuntime(state)?.dirty ?? false;

export const selectActivePendingApprovalCount = (state: RootState): number =>
  activeRuntime(state)?.pendingApprovalCount ?? 0;

export const selectActiveNewestToolbarPreviewForInput = (state: RootState) =>
  activeRuntime(state)?.newestToolbarPreviewForInput ?? EMPTY_PREVIEWS;

export const selectActiveDontMergeReplyBubbles = (state: RootState): boolean =>
  activeRuntime(state)?.dontMergeReplyBubbles ?? true;

export const selectActiveDontMergeHistoricalReplyBubbles = (
  state: RootState,
): boolean => activeRuntime(state)?.dontMergeHistoricalReplyBubbles ?? true;

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

/** Catalog fields (方案.md §五.6), preferring the catalog slice. */
export const selectLastSessionId = (state: RootState): string | undefined =>
  state.sessionCatalog.lastSessionId;

export const selectAllSessionMetadata = (state: RootState) =>
  state.sessionCatalog.allSessionMetadata;

export const selectIsSessionMetadataLoading = (state: RootState): boolean =>
  state.sessionCatalog.isLoading;
