import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { loadFullHistory, loadMoreHistory } from "./sessionPaging";

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
