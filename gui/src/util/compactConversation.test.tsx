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
      await result.current(2);
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
      await result.current(1); // relative index 1 -> absolute 5
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
      await result.current(0);
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
      await wholeHistory.current(0);
    });
    expect(untruncatedRequest).not.toHaveBeenCalledWith(
      "conversation/compact",
      expect.anything(),
    );
    warn.mockRestore();
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
      await result.current(1);
    });

    expect(request).not.toHaveBeenCalledWith(
      "conversation/compact",
      expect.anything(),
    );
    error.mockRestore();
  });
});

describe("useDeleteCompaction", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("deletes the compaction at the absolute index of the scope session", async () => {
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
      await result.current(2);
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

  it("does not re-offset the absolute index a synthetic separator passes", async () => {
    // The separator reports `sourceAbsoluteIndex`, which is already absolute, so
    // it passes `{ absolute: true }` (SyntheticConversationSummary.tsx). Shifting
    // it by the window offset again would target 2 + 4 = 6 — a different message
    // (here: one past the end of the history), silently deleting nothing.
    const store = makeStore({
      scopeSessionId: "A",
      activeSessionId: "A",
      truncated: true,
    });
    const diskHistory = FULL_HISTORY.map((entry, i) =>
      i === 2 ? { ...entry, conversationSummary: "old summary" } : entry,
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
      await result.current(2, { absolute: true });
    });

    // The full load merged the frozen head back in, so the carrier is absolute 2.
    const after = selectSessionById(store.getState() as any, "A")!;
    expect(after.history[2].message.id).toBe("m2");
    expect(after.history[2].conversationSummary).toBeUndefined();
  });
});
