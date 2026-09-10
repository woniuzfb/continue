import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { loadFullHistory, loadMoreHistory } from "./sessionPaging";

function item(
  id: string,
  role: "user" | "assistant" | "thinking",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function legacyItem(
  role: "user" | "assistant",
  content: string,
): ChatHistoryItemWithMessageId {
  return {
    message: { role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function baseSession(
  overrides: Parameters<typeof initialSessionRuntime>[2] = {},
) {
  return initialSessionRuntime("s1", "Chat 1", {
    history: [item("u3", "user", "3"), item("a3", "assistant", "4")],
    pagination: {
      truncated: true,
      loadedOffset: 4,
      totalCount: 6,
      loadedDiskCount: 2,
      hasMore: true,
      loading: false,
      requestGeneration: 0,
      persistPending: false,
    },
    ...overrides,
  });
}

function storeWith(session = baseSession()) {
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1: session },
    },
  });
}

async function run(store: ReturnType<typeof storeWith>, thunk: any) {
  const action = store.dispatch(thunk);
  return (action as any).unwrap();
}

describe("sessionPaging.loadMoreHistory", () => {
  it("prepends the next page and updates disk accounting", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [item("u2", "user", "1"), item("a2", "assistant", "2")],
      firstTurnItems: [],
      hasMore: false,
      total: 6,
      session: { title: "Chat 1", workspaceDirectory: "ws" } as any,
    };

    await run(store, loadMoreHistory({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual([
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    expect(session.pagination.loadedDiskCount).toBe(4);
    expect(session.pagination.loadedOffset).toBe(2);
    expect(session.pagination.truncated).toBe(false);
    expect(session.pagination.hasMore).toBe(false);
    expect(session.pagination.loading).toBe(false);
  });

  it("assigns ids to legacy disk items that have none", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [legacyItem("user", "legacy")],
      firstTurnItems: [],
      hasMore: false,
      total: 3,
      session: { title: "Chat 1", workspaceDirectory: "ws" } as any,
    };

    await run(store, loadMoreHistory({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history[0].message.id).toBeTruthy();
  });

  it("does nothing while the session is streaming or has an unpersisted tail", async () => {
    for (const overrides of [
      { stream: { status: "streaming" as const, requestId: "r" } },
      {
        pagination: {
          truncated: true,
          loadedOffset: 4,
          totalCount: 6,
          loadedDiskCount: 2,
          hasMore: true,
          loading: false,
          requestGeneration: 0,
          persistPending: true,
        },
      },
    ]) {
      const store = storeWith(baseSession(overrides));
      let requested = false;
      store.mockIdeMessenger.responseHandlers["history/loadPage"] =
        async () => {
          requested = true;
          return { items: [], hasMore: false, total: 2, session: {} } as any;
        };
      await run(store, loadMoreHistory({ sessionId: "s1" }));
      expect(requested).toBe(false);
    }
  });

  it("drops a page whose requestGeneration is stale", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responseHandlers["history/loadPage"] = async () => {
      // Simulate a concurrent trim bumping the generation while in flight.
      store.dispatch({
        type: "sessions/setSessionPagination",
        payload: {
          sessionId: "s1",
          pagination: { requestGeneration: 99 },
        },
      });
      return {
        items: [item("u2", "user", "1")],
        firstTurnItems: [],
        hasMore: false,
        total: 6,
        session: {},
      } as any;
    };

    await run(store, loadMoreHistory({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual(["u3", "a3"]);
    expect(session.pagination.loading).toBe(false);
  });
});

describe("sessionPaging.loadFullHistory", () => {
  it("merges the frozen head with the current tail and clears truncation", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      title: "Chat 1",
      workspaceDirectory: "ws",
      history: [
        item("u1", "user", "1"),
        item("a1", "assistant", "2"),
        item("u2", "user", "3"),
        item("a2", "assistant", "4"),
      ],
    } as any;

    await run(store, loadFullHistory({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    expect(session.pagination.truncated).toBe(false);
    expect(session.pagination.loadedOffset).toBe(0);
    expect(session.pagination.loadedDiskCount).toBeUndefined();
    expect(session.pagination.hasMore).toBe(false);
  });

  it("returns the raw disk history, not the hydrated window", async () => {
    // The window already holds a bubble merged by an earlier prepend, so it is
    // shorter than the disk region it covers — exactly the state the mutation
    // paths must resolve against (设计 §4).
    const windowBubble: ChatHistoryItemWithMessageId = {
      ...item("a3", "assistant", "part one part two"),
      mergedReplyProvenance: {
        sourceMessageIds: ["a3", "t3", "a4"],
        firstSourceMessageId: "a3",
        lastSourceMessageId: "a4",
      },
    };
    const store = storeWith(
      baseSession({
        history: [item("u3", "user", "3"), windowBubble],
      }),
    );
    const diskHistory = [
      item("u1", "user", "1"),
      item("a1", "assistant", "2"),
      item("u2", "user", "3"),
      item("a2", "assistant", "4"),
      item("u3", "user", "3"),
      item("a3", "assistant", "part one"),
      item("t3", "thinking", "why"),
      item("a4", "assistant", "part two"),
    ];
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      title: "Chat 1",
      workspaceDirectory: "ws",
      history: diskHistory,
    } as any;

    const result = await run(store, loadFullHistory({ sessionId: "s1" }));

    // The raw response: every disk item, unmerged, in disk order…
    expect(result!.diskHistory.map((i: any) => i.message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
      "t3",
      "a4",
    ]);
    // …while state keeps the merged window (4 frozen head + u3 + bubble).
    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    expect(session.history[5].mergedReplyProvenance?.sourceMessageIds).toEqual([
      "a3",
      "t3",
      "a4",
    ]);
    // The two arrays are deliberately different: the disk one is a temporary
    // return value and must never be stored in state.
    expect(result!.diskHistory).not.toBe(session.history);
  });

  it("merges against the live tail, not the pre-request snapshot", async () => {
    const store = storeWith();
    // While the disk read is in flight the session tail grows (stream chunk /
    // tool result / edit). The merge must keep the live tail.
    store.mockIdeMessenger.responseHandlers["history/load"] = async () => {
      const current = selectSessionById(store.getState() as any, "s1")!;
      store.dispatch({
        type: "sessions/setSessionHistory",
        payload: {
          sessionId: "s1",
          history: [...current.history, item("u4", "user", "late turn")],
        },
      });
      return {
        sessionId: "s1",
        title: "Chat 1",
        workspaceDirectory: "ws",
        history: [
          item("u1", "user", "1"),
          item("a1", "assistant", "2"),
          item("u2", "user", "3"),
          item("a2", "assistant", "4"),
        ],
      } as any;
    };

    await run(store, loadFullHistory({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
      "u4",
    ]);
  });

  it("drops the merge when the window moved while the disk was read", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responseHandlers["history/load"] = async () => {
      // Another load already advanced the window.
      store.dispatch({
        type: "sessions/setSessionPagination",
        payload: { sessionId: "s1", pagination: { loadedOffset: 2 } },
      });
      return {
        sessionId: "s1",
        title: "Chat 1",
        workspaceDirectory: "ws",
        history: [
          item("u1", "user", "1"),
          item("a1", "assistant", "2"),
          item("u2", "user", "3"),
          item("a2", "assistant", "4"),
        ],
      } as any;
    };

    await run(store, loadFullHistory({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual(["u3", "a3"]);
    expect(session.pagination.truncated).toBe(true);
  });

  it("refuses to merge when disk is shorter than the frozen head", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      title: "Chat 1",
      workspaceDirectory: "ws",
      history: [item("u3", "user", "3")],
    } as any;

    await expect(
      run(store, loadFullHistory({ sessionId: "s1" })),
    ).rejects.toThrow("shorter than the expected frozen head");

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual(["u3", "a3"]);
    expect(session.pagination.truncated).toBe(true);
  });
});
