import { Provider } from "react-redux";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionScope } from "../../components/mainInput/TipTapEditor/SessionScope";
import { createMockStore } from "../../util/test/mockStore";
import { useSessionSyntheticSummary } from "./sessionView";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";

/**
 * 方案.md §十一: the synthetic summary separator.
 *
 * The carrier item can be trimmed out of a lazily loaded window. The separator
 * must then appear at the head of the window, disappear as soon as the carrier
 * is loaded back in, and never double up with a real carrier.
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

/** 6 disk items; the loaded window is the last two (loadedOffset 4). */
const WINDOW = [item("m4", "user", "4"), item("m5", "assistant", "5")];
const SUMMARY = {
  sourceMessageId: "m1",
  sourceAbsoluteIndex: 1,
  content: "compacted",
};

function makeStore(
  options: {
    window?: ChatHistoryItemWithMessageId[];
    loadedOffset?: number;
    summary?: typeof SUMMARY | { sourceMessageId: string; content: string };
    activeSessionId?: string;
  } = {},
) {
  const {
    window: history = WINDOW,
    loadedOffset = 4,
    summary = SUMMARY,
    activeSessionId = "A",
  } = options;

  const runtime = initialSessionRuntime("A", "Chat", {
    history,
    latestConversationSummary: summary as any,
    pagination: {
      truncated: loadedOffset > 0,
      loadedOffset,
      totalCount: 6,
      loadedDiskCount: history.length,
      hasMore: loadedOffset > 0,
      loading: false,
      requestGeneration: 0,
      persistPending: false,
    },
  });
  const other = initialSessionRuntime("B", "Other", {
    history: [item("o1", "user", "other")],
    latestConversationSummary: {
      sourceMessageId: "o1",
      sourceAbsoluteIndex: 0,
      content: "other summary",
    },
  });

  return createMockStore({
    sessions: {
      activeSessionId,
      tabOrder: ["A", "B"],
      tabDescriptors: {
        A: { sessionId: "A", title: "Chat", loadState: "loaded" },
        B: { sessionId: "B", title: "Other", loadState: "loaded" },
      },
      sessionsById: { A: runtime, B: other },
    },
  });
}

function wrapperFor(store: ReturnType<typeof makeStore>, sessionId: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>
      <SessionScope sessionId={sessionId}>{children}</SessionScope>
    </Provider>
  );
}

describe("useSessionSyntheticSummary", () => {
  it("returns the summary while the carrier is trimmed out of the window", () => {
    const store = makeStore();
    const { result } = renderHook(() => useSessionSyntheticSummary(), {
      wrapper: wrapperFor(store, "A"),
    });

    expect(result.current?.sourceMessageId).toBe("m1");
    expect(result.current?.content).toBe("compacted");
  });

  it("returns nothing when the carrier is inside the window", () => {
    // loadedOffset 0 and the carrier at absolute index 1 is the second item.
    const store = makeStore({
      window: [item("m0", "user", "0"), item("m1", "assistant", "1")],
      loadedOffset: 0,
    });
    const { result } = renderHook(() => useSessionSyntheticSummary(), {
      wrapper: wrapperFor(store, "A"),
    });

    expect(result.current).toBeUndefined();
  });

  it("disappears once prepending brings the carrier back in", () => {
    const store = makeStore();
    const { result } = renderHook(() => useSessionSyntheticSummary(), {
      wrapper: wrapperFor(store, "A"),
    });
    expect(result.current).toBeDefined();

    act(() => {
      store.dispatch({
        type: "sessions/prependSessionHistory",
        payload: {
          sessionId: "A",
          items: [item("m2", "user", "2"), item("m3", "assistant", "3")],
          hasMore: true,
          newLoadedOffset: 2,
          totalCount: 6,
        },
      });
    });
    // Carrier (absolute 1) is still above the window.
    expect(result.current).toBeDefined();

    act(() => {
      store.dispatch({
        type: "sessions/prependSessionHistory",
        payload: {
          sessionId: "A",
          items: [item("m0", "user", "0"), item("m1", "assistant", "1")],
          hasMore: false,
          newLoadedOffset: 0,
          totalCount: 6,
        },
      });
    });
    // Real carrier is now rendered at its own position.
    expect(result.current).toBeUndefined();
  });

  it("returns nothing when the carrier lives inside a merged bubble", () => {
    // Before the prepend the window was [u0, m0, m1] and the carrier m1 sat at
    // absolute index 2. `prependSessionHistory` merged the group into one bubble
    // whose own id is the group's FIRST assistant (m0), so now:
    //   - the recorded index 2 is out of range, and
    //   - an id scan can never find "m1" (no item carries that id any more).
    // The membership scan is what keeps the separator from rendering at the head
    // of the window, next to the real card the bubble now carries.
    const bubble: ChatHistoryItemWithMessageId = {
      ...item("m0", "assistant", "0 and 1"),
      conversationSummary: "compacted",
      mergedReplyProvenance: {
        sourceMessageIds: ["m0", "m1"],
        firstSourceMessageId: "m0",
        lastSourceMessageId: "m1",
      },
    };
    const store = makeStore({
      window: [item("u0", "user", "q"), bubble],
      loadedOffset: 0,
      summary: { ...SUMMARY, sourceAbsoluteIndex: 2 },
    });
    const { result } = renderHook(() => useSessionSyntheticSummary(), {
      wrapper: wrapperFor(store, "A"),
    });

    expect(result.current).toBeUndefined();
  });

  it("still separates when the merged bubble is not the carrier's bubble", () => {
    // Provenance membership must be the discriminator — not "some bubble exists".
    const otherBubble: ChatHistoryItemWithMessageId = {
      ...item("n0", "assistant", "n0 and n1"),
      mergedReplyProvenance: {
        sourceMessageIds: ["n0", "n1"],
        firstSourceMessageId: "n0",
        lastSourceMessageId: "n1",
      },
    };
    const store = makeStore({
      window: [otherBubble],
      loadedOffset: 0,
      summary: { sourceMessageId: "m1", content: "compacted" },
    });
    const { result } = renderHook(() => useSessionSyntheticSummary(), {
      wrapper: wrapperFor(store, "A"),
    });

    expect(result.current?.sourceMessageId).toBe("m1");
  });

  it("falls back to an id scan for a legacy summary without an index", () => {
    const store = makeStore({
      summary: { sourceMessageId: "m1", content: "legacy" },
    });
    const { result } = renderHook(() => useSessionSyntheticSummary(), {
      wrapper: wrapperFor(store, "A"),
    });
    expect(result.current?.content).toBe("legacy");
  });

  it("is session-scoped: another tab's summary never leaks in", () => {
    const store = makeStore({ activeSessionId: "B" });
    const { result } = renderHook(() => useSessionSyntheticSummary(), {
      wrapper: wrapperFor(store, "A"),
    });

    // The visible tab is B, but the hook reads A's own runtime.
    expect(result.current?.sourceMessageId).toBe("m1");
  });

  it("disappears immediately when the summary is cleared", () => {
    const store = makeStore();
    const { result } = renderHook(() => useSessionSyntheticSummary(), {
      wrapper: wrapperFor(store, "A"),
    });
    expect(result.current).toBeDefined();

    act(() => {
      store.dispatch({
        type: "sessions/clearSessionConversationSummary",
        payload: { sessionId: "A" },
      });
    });
    expect(result.current).toBeUndefined();
  });
});
