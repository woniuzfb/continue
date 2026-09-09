import type { RootState } from "../store";
import type { SessionRuntimeState } from "../slices/sessionsSlice";

/**
 * Phase 4 component migration (方案.md §九).
 *
 * Components must read the active session through these selectors instead of
 * `state.session`. While the un-migrated thunks still write the legacy slice,
 * every selector prefers `sessionsById[activeSessionId]` and falls back to the
 * legacy slice, so migrating a component is behavior-preserving until its
 * writer moves. The fallback disappears together with the legacy slice.
 */

function activeRuntime(state: RootState): SessionRuntimeState | undefined {
  const sessionId = state.sessions.activeSessionId;
  return sessionId ? state.sessions.sessionsById[sessionId] : undefined;
}

export const selectActiveSessionId = (state: RootState): string =>
  state.sessions.activeSessionId ?? state.session.id;

export const selectActiveTitle = (state: RootState): string =>
  activeRuntime(state)?.title ?? state.session.title;

export const selectActiveHistory = (state: RootState) =>
  activeRuntime(state)?.history ?? state.session.history;

export const selectActiveMode = (state: RootState) =>
  activeRuntime(state)?.mode ?? state.session.mode;

export const selectActiveIsStreaming = (state: RootState): boolean => {
  const runtime = activeRuntime(state);
  return runtime
    ? runtime.stream.status === "streaming"
    : state.session.isStreaming;
};

export const selectActiveStreamAborter = (state: RootState) =>
  activeRuntime(state)?.stream.aborter ?? state.session.streamAborter;

export const selectActiveIsInEdit = (state: RootState): boolean =>
  activeRuntime(state)?.isInEdit ?? state.session.isInEdit;

export const selectActiveSymbols = (state: RootState) =>
  activeRuntime(state)?.symbols ?? state.session.symbols;

export const selectActiveCodeBlockApplyStates = (state: RootState) =>
  activeRuntime(state)?.codeBlockApplyStates ??
  state.session.codeBlockApplyStates;

export const selectActiveMainEditorDraft = (state: RootState) =>
  activeRuntime(state)?.mainEditorDraft ?? state.session.mainEditorDraft;

export const selectActiveMainEditorContentTrigger = (state: RootState) =>
  activeRuntime(state)?.mainEditorContentTrigger ??
  state.session.mainEditorContentTrigger;

export const selectActiveMainEditorAttachmentsRestore = (state: RootState) =>
  activeRuntime(state)?.mainEditorAttachmentsRestore ??
  state.session.mainEditorAttachmentsRestore;

export const selectActiveInlineErrorMessage = (state: RootState) =>
  activeRuntime(state)?.inlineErrorMessage ?? state.session.inlineErrorMessage;

export const selectActiveIsPruned = (state: RootState) =>
  activeRuntime(state)?.isPruned ?? state.session.isPruned;

export const selectActiveContextPercentage = (state: RootState) =>
  activeRuntime(state)?.contextPercentage ?? state.session.contextPercentage;

export const selectActiveContextInputTokens = (state: RootState) =>
  activeRuntime(state)?.contextInputTokens ?? state.session.contextInputTokens;

export const selectActiveContextLength = (state: RootState) =>
  activeRuntime(state)?.contextLength ?? state.session.contextLength;

export const selectActiveContextMetrics = (state: RootState) =>
  activeRuntime(state)?.contextMetrics ?? state.session.contextMetrics;

export const selectActiveHasReasoningEnabled = (state: RootState) =>
  activeRuntime(state)?.hasReasoningEnabled ??
  state.session.hasReasoningEnabled;

export const selectActiveDirty = (state: RootState): boolean =>
  activeRuntime(state)?.dirty ?? state.session.dirty ?? false;

export const selectActivePendingApprovalCount = (state: RootState): number =>
  activeRuntime(state)?.pendingApprovalCount ?? 0;

export const selectActiveNewestToolbarPreviewForInput = (state: RootState) =>
  activeRuntime(state)?.newestToolbarPreviewForInput ??
  state.session.newestToolbarPreviewForInput;

export const selectActiveDontMergeReplyBubbles = (state: RootState): boolean =>
  activeRuntime(state)?.dontMergeReplyBubbles ??
  state.session.dontMergeReplyBubbles ??
  true;

export const selectActiveDontMergeHistoricalReplyBubbles = (
  state: RootState,
): boolean =>
  activeRuntime(state)?.dontMergeHistoricalReplyBubbles ??
  state.session.dontMergeHistoricalReplyBubbles ??
  true;

export const selectActiveScrollState = (state: RootState) =>
  activeRuntime(state)?.scrollState;

/** Pagination window, preferring the runtime accounting. */
export const selectActiveHistoryTruncated = (state: RootState): boolean =>
  activeRuntime(state)?.pagination.truncated ??
  state.session.historyTruncated ??
  false;

export const selectActiveHistoryLoadedOffset = (state: RootState): number =>
  activeRuntime(state)?.pagination.loadedOffset ??
  state.session.historyLoadedOffset ??
  0;

export const selectActiveHistoryTotalCount = (state: RootState) =>
  activeRuntime(state)?.pagination.totalCount ??
  state.session.historyTotalCount;

export const selectActiveHasMoreHistory = (state: RootState): boolean =>
  activeRuntime(state)?.pagination.hasMore ??
  state.session.hasMoreHistory ??
  false;

export const selectActiveIsHistoryLoading = (state: RootState): boolean =>
  activeRuntime(state)?.pagination.loading ??
  state.session.isHistoryLoading ??
  false;

export const selectActiveLoadedDiskCount = (state: RootState) =>
  activeRuntime(state)?.pagination.loadedDiskCount ??
  state.session.loadedDiskCount;

/**
 * Compaction loading is keyed by messageId in the runtime (方案.md §五.22) and
 * by history index in the legacy slice, so the migration reads both keys.
 */
export const selectActiveCompactionLoading = (
  state: RootState,
  messageId: string | undefined,
  legacyIndex: number,
): boolean => {
  const runtime = activeRuntime(state);
  if (runtime) {
    return !!messageId && !!runtime.compactionLoading[messageId];
  }
  return !!state.session.compactionLoading[legacyIndex];
};

/** Catalog fields (方案.md §五.6), preferring the catalog slice. */
export const selectLastSessionId = (state: RootState): string | undefined =>
  state.sessionCatalog.lastSessionId ?? state.session.lastSessionId;

export const selectAllSessionMetadata = (state: RootState) =>
  state.sessionCatalog.allSessionMetadata.length > 0
    ? state.sessionCatalog.allSessionMetadata
    : state.session.allSessionMetadata;

export const selectIsSessionMetadataLoading = (state: RootState): boolean =>
  state.sessionCatalog.isLoading || state.session.isSessionMetadataLoading;
