import { createAsyncThunk } from "@reduxjs/toolkit";
import { ChatHistoryItem } from "core";
import { selectSessionById } from "../selectors/sessions";
import {
  requestHistoryFromFullHistory,
  type FullRequestHistorySnapshot,
} from "../util/requestHistory";
import {
  prependSessionHistory,
  setSessionHistory,
  setSessionHistoryLoading,
  setSessionPagination,
  trimSessionHistoryWindow,
} from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";
import { getLazyLoadTrimLimit, planHistoryTrim } from "../util/lazyLoadHistory";
import {
  resolveHistoryTargetOnDisk,
  type HistoryTargetOnDisk,
} from "../util/historyTarget";
import { ensureMessageIdsWithReport } from "../util/messageIds";
import { mergeDiskHeadWithRuntimeTail } from "../util/mergeDiskHead";
import { noteGuiActivity, recordSubmitLatency } from "../../util/submitLatency";
import { reportMessageIdFallback } from "../util/messageIdFallbackReport";
import { emitLegacyFallbackMintedEvent } from "../util/legacyMessageIdObservability";
import {
  selectMessageIdMigrationCapability,
  selectTelemetryHost,
} from "../slices/runtimeCapabilitiesSlice";
import { scheduleMessageIdMigrationIfSafe } from "./sessionMessageIdMigration";

/**
 * Phase 1 paging (方案.md §五.12). Every request captures sessionId +
 * requestGeneration + loadedDiskCount and only writes back to that session;
 * a tab switch never invalidates a legitimate in-flight page.
 */

export const loadMoreHistory = createAsyncThunk<
  void,
  { sessionId: string; requestGeneration?: number },
  ThunkApiType
>(
  "sessions/loadMoreHistory",
  async ({ sessionId, requestGeneration }, { getState, dispatch, extra }) => {
    const session = selectSessionById(getState(), sessionId);
    if (!session) {
      return;
    }
    const { pagination } = session;
    // Discard conditions (方案.md §五.12): already loading, nothing more to
    // load, unpersisted tail, or an in-flight stream on this session.
    if (
      pagination.loading ||
      !pagination.truncated ||
      !pagination.hasMore ||
      pagination.persistPending ||
      session.stream.status === "streaming"
    ) {
      return;
    }
    if (
      requestGeneration !== undefined &&
      requestGeneration !== pagination.requestGeneration
    ) {
      return;
    }

    const generation = pagination.requestGeneration;
    const loadedCount = pagination.loadedDiskCount ?? session.history.length;
    const pageSize = getState().config.config.ui?.lazyLoadHistoryPageSize ?? 4;

    dispatch(setSessionHistoryLoading({ sessionId, loading: true }));

    try {
      const res = await extra.ideMessenger.request("history/loadPage", {
        id: sessionId,
        offset: loadedCount,
        limit: pageSize,
      });

      if (res.status === "error") {
        dispatch(setSessionHistoryLoading({ sessionId, loading: false }));
        return;
      }

      const current = selectSessionById(getState(), sessionId);
      if (
        !current ||
        current.pagination.requestGeneration !== generation ||
        !current.pagination.truncated ||
        current.pagination.persistPending ||
        (current.pagination.loadedDiskCount ?? current.history.length) !==
          loadedCount
      ) {
        dispatch(setSessionHistoryLoading({ sessionId, loading: false }));
        return;
      }

      const { items, hasMore, total } = res.content;
      // P4b-2: report the fallback rather than minting silently — an id minted
      // here is runtime-only and must never be read as a migrated disk identity.
      const itemsReport = ensureMessageIdsWithReport(items);
      if (itemsReport.mintedCount > 0) {
        reportMessageIdFallback({
          sessionId,
          mintedCount: itemsReport.mintedCount,
          hostCapability: selectMessageIdMigrationCapability(getState()),
        });
        emitLegacyFallbackMintedEvent({
          mintedCount: itemsReport.mintedCount,
          host: selectTelemetryHost(getState()),
          messenger: extra.ideMessenger,
        });
      }
      dispatch(
        prependSessionHistory({
          sessionId,
          items: itemsReport.items,
          hasMore,
          newLoadedOffset: total - loadedCount - items.length,
          totalCount: total,
        }),
      );
      // P4a: legacy message ID migration, "paging finished" trigger. Migrating
      // is still correct while the head is unloaded — the migration rewrites the
      // whole disk file, including the frozen head the window never sees.
      void dispatch(scheduleMessageIdMigrationIfSafe({ sessionId }));
    } catch (e) {
      console.warn("loadMoreHistory error:", e);
      dispatch(setSessionHistoryLoading({ sessionId, loading: false }));
    }
  },
);

/**
 * 设计 §4: returns the **raw** on-disk history for this response, as a temporary
 * value for the caller — it is deliberately not stored in Redux (the hydrated
 * `session.history` is not the disk array: it keeps the merged window and only
 * prepends the frozen head).
 *
 * Typed `ChatHistoryItem[]` on purpose: `history/load` is a protocol boundary and
 * legacy sessions may have no persisted `message.id`, so this must not claim
 * `ChatHistoryItemWithMessageId[]`. Only real persisted ids are matchable here;
 * a uuid minted by `ensureMessageIds` in this response is not a stable identity.
 */
export const loadFullHistory = createAsyncThunk<
  { diskHistory: ChatHistoryItem[] } | undefined,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/loadFullHistory",
  async ({ sessionId }, { getState, dispatch, extra }) => {
    const session = selectSessionById(getState(), sessionId);
    if (!session || !session.pagination.truncated) {
      return;
    }

    // Capture the window identity before awaiting: the merge must describe the
    // same window the request was issued for (方案.md §五.12).
    const generation = session.pagination.requestGeneration;
    const headCount = session.pagination.loadedOffset ?? 0;

    // Measured in two parts on purpose: the round trip (Core reads the file and decodes it)
    // versus the GUI merge/dispatch. The first real trace showed 1.36s for the whole thing
    // on every send of a lazy-loaded session, and which half owns it decides the fix.
    const loadStartedAt = performance.now();
    const result = await extra.ideMessenger.request("history/load", {
      id: sessionId,
    });
    recordSubmitLatency({
      phase: "history-load",
      sessionId,
      durationMs: performance.now() - loadStartedAt,
    });
    if (result.status === "error") {
      // Never silently continue on a partial history: the caller unwraps and
      // aborts the send instead of overwriting the session file with a tail.
      throw new Error(`loadFullHistory failed: ${result.error}`);
    }

    // Re-read after the await: the session may have received a stream chunk,
    // tool result, edit or a concurrent full load while the disk was reading.
    // Merging the pre-await snapshot would silently drop those updates.
    const current = selectSessionById(getState(), sessionId);
    if (!current) {
      return;
    }
    if (current.pagination.requestGeneration !== generation) {
      return;
    }
    if ((current.pagination.loadedOffset ?? 0) !== headCount) {
      // The window moved (or another full load already finished).
      return;
    }

    const diskHistory = result.content.history;

    const mergeStartedAt = performance.now();
    // The merge rule lives in one place (`mergeDiskHeadWithRuntimeTail`) so the read-only
    // request loader cannot drift from the hydration path (方案.md §7.2.6).
    const merged = mergeDiskHeadWithRuntimeTail({
      diskHistory,
      // Re-read above, after the await: the window may have changed while the disk was read.
      runtimeHistory: current.history,
      loadedOffset: headCount,
    });
    if (merged.kind === "disk-shorter-than-head") {
      throw new Error(
        `loadFullHistory: on-disk history (${merged.diskLength}) is shorter ` +
          `than the expected frozen head (${merged.headCount}). Refusing to merge ` +
          `a partial context and overwrite the session file; aborting send.`,
      );
    }
    const mergedReport = ensureMessageIdsWithReport(merged.history);
    if (mergedReport.mintedCount > 0) {
      reportMessageIdFallback({
        sessionId,
        mintedCount: mergedReport.mintedCount,
        hostCapability: selectMessageIdMigrationCapability(getState()),
      });
      emitLegacyFallbackMintedEvent({
        mintedCount: mergedReport.mintedCount,
        host: selectTelemetryHost(getState()),
        messenger: extra.ideMessenger,
      });
    }
    noteGuiActivity("hydration", { items: mergedReport.items.length });
    dispatch(
      setSessionHistory({
        sessionId,
        history: mergedReport.items,
        // 方案.md §五.16.1: 全量水合替换的是窗口，完整逻辑会话内容没变。
        origin: "hydration",
      }),
    );
    recordSubmitLatency({
      phase: "history-merge",
      sessionId,
      durationMs: performance.now() - mergeStartedAt,
    });
    dispatch(
      setSessionPagination({
        sessionId,
        pagination: {
          truncated: false,
          loadedOffset: 0,
          loadedDiskCount: undefined,
          hasMore: false,
          loading: false,
        },
      }),
    );

    // Temporary return value only — callers use it to locate a target on disk
    // (设计 §4) and must not put it into state.
    return { diskHistory };
  },
);

/**
 * 方案.md §7.2.6：**只读**取「本次请求用的完整逻辑历史」。
 *
 * 存在的理由：模型请求需要完整历史，而可见窗口按 §十一 保持 lazy。之前这两件事绑在一起 ——
 * 请求路径调用 `loadFullHistory`，把 `session.history` 换成完整会话，于是每个 chunk 都在一份
 * 254 行的窗口上重渲染（实测 `chat-render-commit` 120–234ms/次，伴随秒级主线程停顿），保存后
 * 又被裁回小窗口，形成「放大→重渲染→裁回→再放大」的循环。
 *
 * 这个 thunk 只做读取与合并，**绝不**：
 *
 * ```text
 * setSessionHistory / setSessionPagination
 * mark dirty / 推进 conversationRevision
 * 改 loadedOffset / truncated / loadedDiskCount
 * 触发 hydration 的 UI activity（它不是水合）
 * ```
 *
 * 失败语义（§7.2.6）：**绝不**降级成「用当前截断窗口当请求历史」—— 那会让模型悄悄丢掉上下文。
 * 拿不到可证明正确的快照就抛错，由调用方中止本次发送。
 */
export const loadFullRequestHistory = createAsyncThunk<
  FullRequestHistorySnapshot,
  {
    sessionId: string;
    /** 发起时的窗口代次；磁盘读完后仍必须是这个值。 */
    expectedRequestGeneration: number;
    /** 发起时的内容版本；变化说明窗口内容已不是发起时那份。 */
    expectedConversationRevision: number;
    /** 可见窗口当前的尾部身份（用于确认尾部没被换掉）。 */
    expectedTailMessageId?: string;
  },
  ThunkApiType
>(
  "sessions/loadFullRequestHistory",
  async (
    {
      sessionId,
      expectedRequestGeneration,
      expectedConversationRevision,
      expectedTailMessageId,
    },
    { getState, extra },
  ) => {
    const initial = selectSessionById(getState(), sessionId);
    if (!initial) {
      throw new Error("loadFullRequestHistory: session no longer exists");
    }
    const headCount = initial.pagination.loadedOffset ?? 0;

    const loadStartedAt = performance.now();
    const result = await extra.ideMessenger.request("history/load", {
      id: sessionId,
    });
    recordSubmitLatency({
      phase: "history-load",
      sessionId,
      durationMs: performance.now() - loadStartedAt,
    });
    if (result.status === "error") {
      throw new Error(`loadFullRequestHistory failed: ${result.error}`);
    }

    // Re-read after the await: the window may have received a stream chunk, a tool result, an
    // edit, a prepend or a trim while the disk was being read. Merging the pre-await snapshot
    // would silently drop those updates.
    const current = selectSessionById(getState(), sessionId);
    if (!current) {
      throw new Error(
        "loadFullRequestHistory: session disappeared while loading",
      );
    }
    if (current.pagination.requestGeneration !== expectedRequestGeneration) {
      throw new Error(
        "loadFullRequestHistory: the window generation changed while loading",
      );
    }
    if ((current.pagination.loadedOffset ?? 0) !== headCount) {
      // The window is no longer the one this read started from (a hydration completed, a
      // page was prepended): the merge boundary moved, so merging with the captured
      // `headCount` would duplicate rows instead of restoring the frozen head.
      throw new Error("loadFullRequestHistory: the window moved while loading");
    }
    if (current.conversationRevision !== expectedConversationRevision) {
      throw new Error(
        "loadFullRequestHistory: the conversation changed while loading",
      );
    }
    if (
      expectedTailMessageId !== undefined &&
      (current.history.at(-1)?.message.id ?? undefined) !==
        expectedTailMessageId
    ) {
      throw new Error(
        "loadFullRequestHistory: the visible tail changed while loading",
      );
    }

    const mergeStartedAt = performance.now();
    const merged = mergeDiskHeadWithRuntimeTail({
      diskHistory: result.content.history,
      runtimeHistory: current.history,
      loadedOffset: headCount,
    });
    if (merged.kind === "disk-shorter-than-head") {
      throw new Error(
        `loadFullRequestHistory: on-disk history (${merged.diskLength}) is ` +
          `shorter than the expected frozen head (${merged.headCount}); ` +
          `refusing to build a request from a partial history`,
      );
    }
    const report = ensureMessageIdsWithReport(merged.history);
    if (report.mintedCount > 0) {
      // Same reporting as hydration: the request is built from ids we just minted, and the
      // legacy-migration pipeline must know they are not persisted.
      reportMessageIdFallback({
        sessionId,
        mintedCount: report.mintedCount,
        hostCapability: selectMessageIdMigrationCapability(getState()),
      });
      emitLegacyFallbackMintedEvent({
        mintedCount: report.mintedCount,
        host: selectTelemetryHost(getState()),
        messenger: extra.ideMessenger,
      });
    }
    recordSubmitLatency({
      phase: "history-merge",
      sessionId,
      durationMs: performance.now() - mergeStartedAt,
    });

    return requestHistoryFromFullHistory(report.items, {
      latestConversationSummary: current.latestConversationSummary,
    });
  },
);

/**
 * 方案.md §九.5/§九.7: after a save proves the window is on disk, release the
 * frozen head from memory by trimming the visible window to
 * `max(lazyLoadHistoryInitialCount, 当前完整回合)`.
 *
 * Self-guarding so it is safe to call from any save path: every condition is
 * re-read from state, and the caller only supplies the authoritative disk count
 * from the matching `history/save` response.
 *
 * Deliberately out of scope for this step: 方案.md §九.8(切出后台 trim) and
 * §九.9(流式期间 trim 已落盘旧头部) — both need the scroll-anchor path proven
 * first. So this never runs while the model is actually streaming
 * (`stream.status === "streaming"`) and never while a tool approval is pending.
 *
 * Note the state matrix (方案.md 已知限制 #51): `pauseSessionStream` writes
 * `status: "idle"` + live `requestId`, so awaiting-approval and a pending edit
 * apply are both `idle`.
 *
 * A pending tool approval is excluded by `pendingApprovalCount > 0`.
 * Waiting for an edit apply is represented as `idle` with a live requestId,
 * so it is not independently excluded here. `planHistoryTrim` still retains
 * the complete current turn from the latest user message to the history tail.
 */
export const reconcilePaginationAfterPersist = createAsyncThunk<
  boolean,
  { sessionId: string; savedRevision: number; totalHistoryCount?: number },
  ThunkApiType
>(
  "sessions/reconcilePaginationAfterPersist",
  async (
    { sessionId, savedRevision, totalHistoryCount },
    { getState, dispatch },
  ) => {
    const state = getState();
    const ui = state.config.config?.ui;
    if (!ui?.lazyLoadHistory) {
      return false;
    }
    const session = selectSessionById(state, sessionId);
    if (!session) {
      return false;
    }

    const persistence = session.persistence;
    // Stale or failed saves never trim (方案.md §七.6/§七.7): a newer revision
    // means content arrived while the request was in flight, so the response
    // describes an older window.
    if (!persistence || persistence.state !== "clean") {
      return false;
    }
    if (persistence.revision !== savedRevision) {
      return false;
    }
    if (!persistence.hasPersistedBaseline) {
      return false;
    }
    // 方案.md §九.4: the stream is only "idle" / "streaming" / "failed" —
    // `stopSessionStream` aborts the controller instead of writing an
    // "aborting" state, so "streaming" is the only unsafe value here.
    if (session.stream.status === "streaming") {
      return false;
    }
    if (session.pendingApprovalCount > 0) {
      return false;
    }
    if (session.pagination.loading) {
      return false;
    }
    if (session.pagination.persistPending) {
      return false;
    }

    // 方案.md §九.7: the save just rewrote the disk tail with this very window,
    // so the window's disk length is now `history.length`. `loadedDiskCount` is
    // still the PRE-save raw-page count (bubble merge makes it larger), and
    // `loadMoreHistory` passes it straight to `history/loadPage` as `offset` —
    // a stale value would skip items and leave a hole in the window. Only
    // reconcile when the response proves the head/window split.
    const loadedOffset = session.pagination.loadedOffset ?? 0;
    const diskSplitIsAuthoritative =
      totalHistoryCount !== undefined &&
      totalHistoryCount === loadedOffset + session.history.length;
    if (
      diskSplitIsAuthoritative &&
      session.pagination.truncated &&
      session.pagination.loadedDiskCount !== session.history.length
    ) {
      dispatch(
        setSessionPagination({
          sessionId,
          pagination: { loadedDiskCount: session.history.length },
        }),
      );
    }

    // 方案.md §7.2.8: the floor comes from the session's own runtime state, written by the view
    // that is showing it and zeroed when that view stops showing it. This thunk must never
    // resolve the visible session itself (§五.20: only the shell reads `activeSessionId`), and
    // it must not need to: a background session's view already zeroed its count on the way out.
    const visibleFloor = session.visibleHistoryCount;
    const plan = planHistoryTrim(
      session,
      getLazyLoadTrimLimit(ui.lazyLoadHistoryInitialCount),
      totalHistoryCount,
      visibleFloor,
    );
    if (!plan) {
      return false;
    }
    // Gated diagnostic: without it, "the transcript shrank after the reply finished" can only
    // be inferred from the row count in the next render. `items` is the window before the trim,
    // `keepItems` what survives and `floorItems` what the viewport was showing.
    recordSubmitLatency({
      phase: "history-trim",
      sessionId,
      items: session.history.length,
      keepItems: plan.keepCount,
      floorItems: visibleFloor,
    });

    dispatch(
      trimSessionHistoryWindow({
        sessionId,
        keepCount: plan.keepCount,
        removedDiskItems: plan.removedDiskItems,
        fullDiskItemCount: plan.fullDiskItemCount,
        retainedDiskItemCount: plan.retainedDiskItemCount,
      }),
    );
    return true;
  },
);

/**
 * 设计 §4/§5: turn one stable message identity into the two coordinates a
 * mutation needs.
 *
 * This is the single mutation-resolution entry point that obtains the raw disk
 * array — either through the existing `loadFullHistory` (which also hydrates the
 * window) or through a read-only `history/load`. It is called only when the
 * window holds a merge that is not on disk yet (`windowHasUnsavedMerge`); while
 * the window is still index-compatible with disk the callers keep the provable
 * `loadedOffset + windowIndex` arithmetic and never get here — the default
 * configuration therefore issues no extra read.
 *
 * Two sources, one shape:
 *
 * - truncated window → `loadFullHistory` hydrates it (a mutation is an explicit
 *   full-hydration operation, 方案.md §十一) and already hands back the raw
 *   array it read;
 * - already hydrated window → the window is *not* the disk array while it holds
 *   an unsaved merged bubble, so read the raw array **without writing state**.
 *
 * Either side missing, or the target not being found in both arrays, returns
 * `undefined`: the caller aborts explicitly rather than guessing an index
 * (方案.md §十二).
 */
export const resolveHistoryMutationTarget = createAsyncThunk<
  HistoryTargetOnDisk | undefined,
  { sessionId: string; targetMessageId: string },
  ThunkApiType
>(
  "sessions/resolveHistoryMutationTarget",
  async ({ sessionId, targetMessageId }, { getState, dispatch, extra }) => {
    const session = selectSessionById(getState(), sessionId);
    if (!session) {
      return undefined;
    }

    let diskHistory: ChatHistoryItem[] | undefined;
    if (session.pagination.truncated) {
      diskHistory = (await dispatch(loadFullHistory({ sessionId })).unwrap())
        ?.diskHistory;
    } else {
      const res = await extra.ideMessenger.request("history/load", {
        id: sessionId,
      });
      if (res.status === "error") {
        return undefined;
      }
      diskHistory = res.content.history;
    }
    if (!diskHistory) {
      return undefined;
    }

    // Re-read the window after the await: a full load replaces `session.history`,
    // and only the post-await array shares the caller's coordinate system.
    const current = selectSessionById(getState(), sessionId);
    if (!current) {
      return undefined;
    }
    return resolveHistoryTargetOnDisk({
      rawDiskHistory: diskHistory,
      guiHistory: current.history,
      targetMessageId,
    });
  },
);
