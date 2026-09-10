import { act, renderHook } from "@testing-library/react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdeMessengerProvider } from "../context/IdeMessenger";
import { SessionScope } from "../components/mainInput/TipTapEditor/SessionScope";
import { createMockStore } from "../util/test/mockStore";
import { selectSessionById } from "../redux/selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../redux/slices/sessionsSlice";
import { resetSessionSaveQueues } from "../redux/thunks/sessionPersistence";
import {
  useCompactConversation,
  useDeleteCompaction,
} from "./compactConversation";

/**
 * 方案.md §十一 / §十六: compaction and lazy loading interact in a way that is
 * easy to get wrong — the UI index is relative to the loaded window while the
 * Core API expects an absolute index into the full history, and the result has
 * to be written back to the session that started it (never to the visible tab).
 */

function item(
  id: string,
  role: "user" | "assistant",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

/** 6 disk items; the loaded window is the last 2 with a 4-item frozen head. */
const FULL_HISTORY = [
  item("m0", "user", "q0"),
  item("m1", "assistant", "a0"),
  item("m2", "user", "q1"),
  item("m3", "assistant", "a1"),
  item("m4", "user", "q2"),
  item("m5", "assistant", "a2"),
];

function makeStore(options: {
  scopeSessionId: string;
  activeSessionId: string;
  truncated?: boolean;
  runtimeSessionId?: string;
  /** Pre-existing compaction summary, applied before the store freezes state. */
  summaryAt?: { index: number; text: string };
}) {
  const {
    scopeSessionId,
    activeSessionId,
    truncated = false,
    runtimeSessionId = scopeSessionId,
    summaryAt,
  } = options;

  const baseHistory = truncated ? FULL_HISTORY.slice(4) : FULL_HISTORY;
  const history = summaryAt
    ? baseHistory.map((entry, i) =>
        i === summaryAt.index
          ? { ...entry, conversationSummary: summaryAt.text }
          : entry,
      )
    : baseHistory;

  const runtime = initialSessionRuntime(runtimeSessionId, "Chat", {
    history,
    ...(summaryAt
      ? {
          latestConversationSummary: {
            sourceMessageId: history[summaryAt.index]?.message.id ?? "",
            sourceAbsoluteIndex: summaryAt.index,
            content: summaryAt.text,
          },
        }
      : {}),
    // Only override pagination when the window is truncated: passing
    // `pagination: undefined` would replace the default with undefined.
    ...(truncated
      ? {
          pagination: {
            truncated: true,
            loadedOffset: 4,
            totalCount: 6,
            loadedDiskCount: 2,
            hasMore: false,
            loading: false,
            requestGeneration: 0,
            persistPending: false,
          },
        }
      : {}),
  });

  const sessionsById: Record<
    string,
    ReturnType<typeof initialSessionRuntime>
  > = { [runtimeSessionId]: runtime };
  if (activeSessionId !== runtimeSessionId) {
    // A second, visible session that must stay untouched.
    sessionsById[activeSessionId] = initialSessionRuntime(
      activeSessionId,
      "Visible",
      { history: [item("v0", "user", "visible")] },
    );
  }

  const store = createMockStore({
    sessions: {
      activeSessionId,
      tabOrder: [activeSessionId, runtimeSessionId],
      tabDescriptors: {
        [activeSessionId]: {
          sessionId: activeSessionId,
          title: "Visible",
          loadState: "loaded" as const,
        },
        [runtimeSessionId]: {
          sessionId: runtimeSessionId,
          title: "Chat",
          loadState: "loaded" as const,
        },
      },
      sessionsById,
    },
  });
  return store;
}

function wrapperFor(
  store: ReturnType<typeof makeStore>,
  scopeSessionId: string,
) {
  return ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>
      <IdeMessengerProvider messenger={store.mockIdeMessenger}>
        <SessionScope sessionId={scopeSessionId}>{children}</SessionScope>
      </IdeMessengerProvider>
    </Provider>
  );
}

describe("useCompactConversation", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("targets the SessionScope session, not the visible tab", async () => {
    const store = makeStore({
      scopeSessionId: "A",
      activeSessionId: "B",
    });
    store.mockIdeMessenger.responses["conversation/compact"] = "summary text";
    // The authoritative save response carries the new summary back (方案.md §七.8.1).
    store.mockIdeMessenger.responses["history/save"] = {
      firstTurnItems: [],
      totalHistoryCount: FULL_HISTORY.length,
      latestConversationSummary: {
        sourceMessageId: "m2",
        sourceAbsoluteIndex: 2,
        content: "summary text",
      },
    } as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const { result } = renderHook(() => useCompactConversation(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      await result.current({ index: 2 });
    });

    expect(request).toHaveBeenCalledWith("conversation/compact", {
      index: 2,
      sessionId: "A",
    });

    const a = selectSessionById(store.getState() as any, "A")!;
    expect(a.history[2].conversationSummary).toBe("summary text");
    // The runtime summary (what the Local Provider sends) updates immediately.
    expect(a.latestConversationSummary).toEqual({
      sourceMessageId: a.history[2].message.id,
      sourceAbsoluteIndex: 2,
      content: "summary text",
    });
    const b = selectSessionById(store.getState() as any, "B")!;
    expect(b.history[0].conversationSummary).toBeUndefined();
  });

  it("offsets the relative index and writes back after a full load", async () => {
    // Regression: the loaded window is captured during render, so a stale
    // closure would index the truncated array with an absolute index and never
    // write the summary back.
    const store = makeStore({
      scopeSessionId: "A",
      activeSessionId: "A",
      truncated: true,
    });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "A",
      title: "Chat",
      workspaceDirectory: "/w",
      history: FULL_HISTORY,
    } as any;
    store.mockIdeMessenger.responses["conversation/compact"] = "summary text";
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const { result } = renderHook(() => useCompactConversation(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      await result.current({ index: 1 }); // relative index 1 -> absolute 5
    });

    expect(request).toHaveBeenCalledWith("conversation/compact", {
      index: 5,
      sessionId: "A",
    });
    const session = selectSessionById(store.getState() as any, "A")!;
    expect(session.history).toHaveLength(6);
    expect(session.history[5].message.id).toBe("m5");
    expect(session.history[5].conversationSummary).toBe("summary text");
  });

  it("refuses to compact the first turn even when it is off-window", async () => {
    const store = makeStore({
      scopeSessionId: "A",
      activeSessionId: "A",
      truncated: true,
    });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "A",
      title: "Chat",
      workspaceDirectory: "/w",
      history: FULL_HISTORY,
    } as any;
    store.mockIdeMessenger.responses["conversation/compact"] = "summary text";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const { result } = renderHook(() => useCompactConversation(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      // Relative 0 with a 4-item frozen head is absolute 4, so it is allowed;
      // an absolute 0 only happens when the window starts at the first turn.
      await result.current({ index: 0 });
    });
    expect(request).toHaveBeenCalledWith("conversation/compact", {
      index: 4,
      sessionId: "A",
    });

    // Without truncation the relative index is already absolute, so index 0 is
    // the first turn and must be refused.
    const untruncated = makeStore({
      scopeSessionId: "A",
      activeSessionId: "A",
    });
    const untruncatedRequest = vi.spyOn(
      untruncated.mockIdeMessenger,
      "request",
    );
    const { result: wholeHistory } = renderHook(
      () => useCompactConversation(),
      {
        wrapper: wrapperFor(untruncated, "A"),
      },
    );
    await act(async () => {
      await wholeHistory.current({ index: 0 });
    });
    expect(untruncatedRequest).not.toHaveBeenCalledWith(
      "conversation/compact",
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("accepts an explicit message id and resolves it without an index", async () => {
    // The compact-all entry (ContextStatus) hands over the window's last item by
    // identity instead of an arithmetic tail (方案.md §十二).
    const store = makeStore({
      scopeSessionId: "A",
      activeSessionId: "A",
      truncated: true,
    });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "A",
      title: "Chat",
      workspaceDirectory: "/w",
      history: FULL_HISTORY,
    } as any;
    store.mockIdeMessenger.responses["conversation/compact"] = "summary text";
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const { result } = renderHook(() => useCompactConversation(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      await result.current({ messageId: "m5" });
    });

    expect(request).toHaveBeenCalledWith("conversation/compact", {
      index: 5,
      sessionId: "A",
    });
    const after = selectSessionById(store.getState() as any, "A")!;
    expect(after.history[5].message.id).toBe("m5");
    expect(after.history[5].conversationSummary).toBe("summary text");
  });

  it("aborts when the full history cannot be loaded", async () => {
    const store = makeStore({
      scopeSessionId: "A",
      activeSessionId: "A",
      truncated: true,
    });
    store.mockIdeMessenger.responses["history/load"] = undefined as any;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const { result } = renderHook(() => useCompactConversation(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      await result.current({ index: 1 });
    });

    expect(request).not.toHaveBeenCalledWith(
      "conversation/compact",
      expect.anything(),
    );
    error.mockRestore();
  });

  it("sends the group-tail disk index for a pre-save merged bubble", async () => {
    // 设计 §5: a merged bubble's own id is its group's **first** assistant, while
    // the disk item its content ends at is the group's **last** raw member — here
    // a `thinking` item (role is deliberately not restricted). Addressing it by
    // window index would send 2 (`loadedOffset` + index) or 4, both of which are
    // a different message on disk.
    const trace = (
      id: string,
      memberIds: string[],
    ): ChatHistoryItemWithMessageId => ({
      ...item(id, "assistant", "merged"),
      mergedReplyProvenance: {
        sourceMessageIds: memberIds,
        firstSourceMessageId: memberIds[0],
        lastSourceMessageId: memberIds[memberIds.length - 1],
      },
    });
    const disk = [
      item("m0", "user", "q0"),
      item("m1", "assistant", "a0"),
      item("m2", "assistant", "a1 part 1"),
      item("m3", "assistant", "a1 part 2"),
      item("u5", "user", "q2"),
      item("m5", "assistant", "a2 part 1"),
      item("m6", "assistant", "a2 part 2"),
      {
        ...item("t7", "assistant", "reasoning"),
        message: {
          id: "t7",
          role: "thinking",
          content: "reasoning",
        } as ChatHistoryItemWithMessageId["message"],
      },
    ];
    const runtime = initialSessionRuntime("A", "Chat", {
      history: [
        trace("m2", ["m2", "m3"]),
        item("u5", "user", "q2"),
        trace("m5", ["m5", "m6", "t7"]),
      ],
      pagination: {
        truncated: true,
        loadedOffset: 2,
        totalCount: disk.length,
        loadedDiskCount: 6,
        hasMore: true,
        loading: false,
        requestGeneration: 0,
        persistPending: false,
      },
    });
    const store = createMockStore({
      sessions: {
        activeSessionId: "A",
        tabOrder: ["A"],
        tabDescriptors: {
          A: { sessionId: "A", title: "Chat", loadState: "loaded" },
        },
        sessionsById: { A: runtime },
      },
    });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "A",
      title: "Chat",
      workspaceDirectory: "/w",
      history: disk,
    } as any;
    store.mockIdeMessenger.responses["conversation/compact"] = "summary text";
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const { result } = renderHook(() => useCompactConversation(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      await result.current({ index: 2 });
    });

    // The carrier `t7` lives at disk index 7, not at the bubble's window index.
    expect(request).toHaveBeenCalledWith("conversation/compact", {
      index: 7,
      sessionId: "A",
    });

    // The write-back addresses the same carrier from the other coordinate
    // system: after hydration the bubble sits at index 4 of the window.
    const after = selectSessionById(store.getState() as any, "A")!;
    expect(after.history).toHaveLength(5);
    expect(after.history[4].message.id).toBe("m5");
    expect(after.history[4].conversationSummary).toBe("summary text");
  });

  it("aborts when the carrier has no matching disk id (legacy session)", async () => {
    // A legacy session's window ids come from `ensureMessageIds`, so they are not
    // persisted identities (方案.md §九.13). The merge-aware path must abort
    // explicitly rather than fall back to an arithmetic index.
    const runtime = initialSessionRuntime("A", "Chat", {
      history: [
        item("u4", "user", "q2"),
        {
          ...item("m5", "assistant", "merged"),
          mergedReplyProvenance: {
            sourceMessageIds: ["m5", "m6"],
            firstSourceMessageId: "m5",
            lastSourceMessageId: "m6",
          },
        },
      ],
      pagination: {
        truncated: true,
        loadedOffset: 0,
        totalCount: 3,
        loadedDiskCount: 1,
        hasMore: true,
        loading: false,
        requestGeneration: 0,
        persistPending: false,
      },
    });
    const store = createMockStore({
      sessions: {
        activeSessionId: "A",
        tabOrder: ["A"],
        tabDescriptors: {
          A: { sessionId: "A", title: "Chat", loadState: "loaded" },
        },
        sessionsById: { A: runtime },
      },
    });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "A",
      title: "Chat",
      workspaceDirectory: "/w",
      // No `message.id` anywhere — as written by an older host.
      history: [
        { message: { role: "user", content: "old" }, contextItems: [] },
        { message: { role: "assistant", content: "old" }, contextItems: [] },
        { message: { role: "user", content: "old" }, contextItems: [] },
      ],
    } as any;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const { result } = renderHook(() => useCompactConversation(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      await result.current({ index: 1 });
    });

    expect(request).not.toHaveBeenCalledWith(
      "conversation/compact",
      expect.anything(),
    );
    const after = selectSessionById(store.getState() as any, "A")!;
    expect(after.history[1].conversationSummary).toBeUndefined();
    warn.mockRestore();
  });
});

describe("useDeleteCompaction", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("deletes the compaction addressed by message id, in the scope session", async () => {
    const store = makeStore({
      scopeSessionId: "A",
      activeSessionId: "B",
      summaryAt: { index: 2, text: "old summary" },
    });
    const seeded = selectSessionById(store.getState() as any, "A")!;
    expect(seeded.history[2].conversationSummary).toBe("old summary");
    expect(seeded.latestConversationSummary?.content).toBe("old summary");

    const { result } = renderHook(() => useDeleteCompaction(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      await result.current("m2");
    });

    const after = selectSessionById(store.getState() as any, "A")!;
    expect(after.history[2].conversationSummary).toBeUndefined();
    // The Local Provider override must stop using the deleted summary
    // immediately, not only after the save response (方案.md §十一).
    expect(after.latestConversationSummary).toBeUndefined();
    // The visible session keeps its own history untouched.
    const visible = selectSessionById(store.getState() as any, "B")!;
    expect(visible.history[0].message.content).toBe("visible");
  });

  it("targets the id even when the recorded absolute index disagrees", async () => {
    // Audit §5 / test 13: the runtime summary carries both an id and an index,
    // and the index can be stale (an edit or a merge moved the carrier). The id
    // is the authority — an index-based lookup would clear absolute index 0.
    const store = makeStore({
      scopeSessionId: "A",
      activeSessionId: "A",
      truncated: true,
    });
    const diskHistory = FULL_HISTORY.map((entry, i) =>
      i === 0
        ? { ...entry, conversationSummary: "untouched" }
        : i === 2
          ? { ...entry, conversationSummary: "old summary" }
          : entry,
    );
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "A",
      title: "Chat",
      workspaceDirectory: "/w",
      history: diskHistory,
    } as any;

    const { result } = renderHook(() => useDeleteCompaction(), {
      wrapper: wrapperFor(store, "A"),
    });

    await act(async () => {
      await result.current("m2");
    });

    // The full load merged the frozen head back in, so the carrier is at 2.
    const after = selectSessionById(store.getState() as any, "A")!;
    expect(after.history[2].message.id).toBe("m2");
    expect(after.history[2].conversationSummary).toBeUndefined();
    // The carrier at absolute index 0 — what the stale index would have hit —
    // is untouched.
    expect(after.history[0].message.id).toBe("m0");
    expect(after.history[0].conversationSummary).toBe("untouched");
  });
});
