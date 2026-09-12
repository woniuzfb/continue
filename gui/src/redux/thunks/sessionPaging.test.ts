import { describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  initialSessionRuntime,
  removeSessionRuntime,
  setSessionPagination,
  updateHistoryItemByMessageId,
} from "../slices/sessionsSlice";
import {
  loadFullHistory,
  loadFullRequestHistory,
  loadMoreHistory,
  reconcilePaginationAfterPersist,
} from "./sessionPaging";

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

function diskResponse() {
  return {
    sessionId: "s1",
    title: "Chat 1",
    workspaceDirectory: "ws",
    // The frozen head (4) followed by the two items the window already has.
    history: [
      item("h1", "user", "head user"),
      item("h2", "assistant", "head answer"),
      item("h3", "user", "head user 2"),
      item("h4", "assistant", "head answer 2"),
      item("u3", "user", "3"),
      item("a3", "assistant", "4"),
    ],
  };
}

describe("sessionPaging.loadFullRequestHistory (方案.md §7.2.6)", () => {
  /**
   * The contract of this thunk is a **negative** one: it may read disk and merge, and nothing
   * else. Every assertion below is about what did *not* happen to the visible window — that is
   * the whole point of decoupling the request history from it (the amplification loop).
   */
  it("merges the frozen head without touching the window", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responses["history/load"] = diskResponse() as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const before = selectSessionById(store.getState() as any, "s1")!;
    const revisionBefore = before.conversationRevision;

    const snapshot = await run(
      store,
      loadFullRequestHistory({
        sessionId: "s1",
        expectedRequestGeneration: 0,
        expectedConversationRevision: revisionBefore,
        expectedTailMessageId: "a3",
      }),
    );

    // The request history is complete: frozen head + the window, in order.
    expect(snapshot.history.map((i: any) => i.message.id)).toEqual([
      "h1",
      "h2",
      "h3",
      "h4",
      "u3",
      "a3",
    ]);

    // …and the window is exactly as it was: same rows, same pagination, same revision.
    const after = selectSessionById(store.getState() as any, "s1")!;
    expect(after.history.map((i) => i.message.id)).toEqual(["u3", "a3"]);
    expect(after.pagination.truncated).toBe(true);
    expect(after.pagination.loadedOffset).toBe(4);
    expect(after.pagination.loadedDiskCount).toBe(2);
    expect(after.pagination.requestGeneration).toBe(0);
    expect(after.conversationRevision).toBe(revisionBefore);

    // No hydration action, and no save: a read-only snapshot must not be persisted either
    // (the save path still sees the lazy window plus its truncation metadata).
    const actionTypes = store.getActions().map((a: any) => a.type);
    expect(actionTypes).not.toContain("sessions/setSessionHistory");
    expect(actionTypes).not.toContain("sessions/setSessionPagination");
    expect(
      request.mock.calls.filter(([type]) => type === "history/save"),
    ).toHaveLength(0);
  });

  it("returns the first turn and the live conversation summary with the snapshot", async () => {
    const summary = {
      sourceMessageId: "h2",
      sourceAbsoluteIndex: 1,
      content: "summary text",
    };
    const session = baseSession({ latestConversationSummary: summary });
    const store = storeWith(session);
    store.mockIdeMessenger.responses["history/load"] = diskResponse() as any;

    const snapshot = await run(
      store,
      loadFullRequestHistory({
        sessionId: "s1",
        expectedRequestGeneration: 0,
        expectedConversationRevision: session.conversationRevision,
        expectedTailMessageId: "a3",
      }),
    );

    expect(snapshot.firstTurnItems.map((i: any) => i.message.id)).toEqual([
      "h1",
      "h2",
    ]);
    expect(snapshot.latestConversationSummary).toEqual(summary);
  });

  it("rejects a read whose revision moved, instead of merging a stale window", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responseHandlers["history/load"] = async () => {
      // A concurrent write lands while the disk is being read.
      store.dispatch(
        updateHistoryItemByMessageId({
          sessionId: "s1",
          messageId: "a3",
          updates: {
            message: item("a3", "assistant", "changed").message,
          },
        }),
      );
      return diskResponse() as any;
    };

    await expect(
      run(
        store,
        loadFullRequestHistory({
          sessionId: "s1",
          expectedRequestGeneration: 0,
          expectedConversationRevision: selectSessionById(
            store.getState() as any,
            "s1",
          )!.conversationRevision,
          expectedTailMessageId: "a3",
        }),
      ),
    ).rejects.toThrow("the conversation changed while loading");

    // The caller retries or aborts — the window is untouched by the failed read.
    const after = selectSessionById(store.getState() as any, "s1")!;
    expect(after.history.map((i) => i.message.id)).toEqual(["u3", "a3"]);
    expect(after.pagination.loadedOffset).toBe(4);
  });

  it("rejects a read whose visible tail was replaced", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responses["history/load"] = diskResponse() as any;
    const session = selectSessionById(store.getState() as any, "s1")!;

    await expect(
      run(
        store,
        loadFullRequestHistory({
          sessionId: "s1",
          expectedRequestGeneration: 0,
          expectedConversationRevision: session.conversationRevision,
          expectedTailMessageId: "u3",
        }),
      ),
    ).rejects.toThrow("the visible tail changed while loading");
  });

  it("rejects a read whose window moved, instead of merging two different windows", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responseHandlers["history/load"] = async () => {
      // A manual "load more" prepends a page: the merge boundary moved with it.
      store.dispatch(
        setSessionPagination({
          sessionId: "s1",
          pagination: {
            truncated: true,
            loadedOffset: 2,
            loadedDiskCount: 4,
            hasMore: false,
            loading: false,
          },
        }),
      );
      return diskResponse() as any;
    };

    await expect(
      run(
        store,
        loadFullRequestHistory({
          sessionId: "s1",
          expectedRequestGeneration: 0,
          expectedConversationRevision: 0,
          expectedTailMessageId: "a3",
        }),
      ),
    ).rejects.toThrow("the window moved while loading");
  });

  it("refuses a partial read rather than sending a truncated history", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responses["history/load"] = {
      ...diskResponse(),
      history: [item("u3", "user", "3"), item("a3", "assistant", "4")],
    } as any;

    await expect(
      run(
        store,
        loadFullRequestHistory({
          sessionId: "s1",
          expectedRequestGeneration: 0,
          expectedConversationRevision: 0,
          expectedTailMessageId: "a3",
        }),
      ),
    ).rejects.toThrow("refusing to build a request from a partial history");
  });

  it("propagates a disk read failure instead of falling back to the window", async () => {
    const store = storeWith();
    // The real IDE path answers with an error envelope rather than throwing.
    const original = store.mockIdeMessenger.request.bind(
      store.mockIdeMessenger,
    );
    (store.mockIdeMessenger as any).request = vi.fn(
      async (type: string, data: any) =>
        type === "history/load"
          ? { status: "error", error: "disk on fire", done: true }
          : original(type as any, data as any),
    ) as any;

    await expect(
      run(
        store,
        loadFullRequestHistory({
          sessionId: "s1",
          expectedRequestGeneration: 0,
          expectedConversationRevision: 0,
          expectedTailMessageId: "a3",
        }),
      ),
    ).rejects.toThrow("loadFullRequestHistory failed");
  });

  it("rejects when the session disappeared during the read", async () => {
    const store = storeWith();
    store.mockIdeMessenger.responseHandlers["history/load"] = async () => {
      store.dispatch(removeSessionRuntime({ sessionId: "s1" }));
      return diskResponse() as any;
    };

    await expect(
      run(
        store,
        loadFullRequestHistory({
          sessionId: "s1",
          expectedRequestGeneration: 0,
          expectedConversationRevision: 0,
          expectedTailMessageId: "a3",
        }),
      ),
    ).rejects.toThrow("session disappeared while loading");
  });
});

describe("sessionPaging.reconcilePaginationAfterPersist (方案.md §7.2.8)", () => {
  /** A window of `count` rows on top of `headCount` frozen disk items. */
  function windowed(count: number, headCount = 10) {
    const history: ChatHistoryItemWithMessageId[] = [];
    for (let i = 0; i < count; i++) {
      history.push(
        item(`m${i}`, i % 2 === 0 ? "user" : "assistant", `row ${i}`),
      );
    }
    return initialSessionRuntime("s1", "Chat 1", {
      history,
      pagination: {
        truncated: true,
        loadedOffset: headCount,
        loadedDiskCount: count,
        hasMore: true,
        loading: false,
        requestGeneration: 0,
        persistPending: false,
      },
      persistence: {
        state: "clean",
        revision: 3,
        persistedRevision: 3,
        hasPersistedBaseline: true,
      },
    });
  }

  function storeWithWindow(
    count: number,
    visibleHistoryCount: number,
    options: { lazyLoad?: boolean; activeSessionId?: string } = {},
  ) {
    const session = windowed(count);
    session.visibleHistoryCount = visibleHistoryCount;
    return createMockStore({
      sessions: {
        activeSessionId: options.activeSessionId ?? "s1",
        tabOrder: ["s1", "s2"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
          s2: { sessionId: "s2", title: "Chat 2", loadState: "loaded" },
        },
        sessionsById: {
          s1: session,
          s2: initialSessionRuntime("s2", "Chat 2", {}),
        },
      },
      config: {
        ...INITIAL_CONFIG_SLICE,
        config: {
          ...INITIAL_CONFIG_SLICE.config,
          ui: {
            lazyLoadHistory: options.lazyLoad ?? true,
            lazyLoadHistoryInitialCount: 4,
          },
        },
      },
    });
  }

  it("keeps every row the viewport is showing", async () => {
    // 12 rows, 4 of them off-screen: the trim may release those 4 and nothing else.
    const store = storeWithWindow(12, 8);
    await run(
      store,
      reconcilePaginationAfterPersist({
        sessionId: "s1",
        savedRevision: 3,
        totalHistoryCount: 10 + 12,
      }),
    );

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual([
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
      "m10",
      "m11",
    ]);
    expect(session.pagination.loadedOffset).toBe(14);
  });

  it("trims down to the limit when nothing is on screen", async () => {
    // A session that is not visible has no floor: the memory win stays exactly as designed.
    const store = storeWithWindow(12, 0);
    await run(
      store,
      reconcilePaginationAfterPersist({
        sessionId: "s1",
        savedRevision: 3,
        totalHistoryCount: 10 + 12,
      }),
    );
    expect(
      selectSessionById(store.getState() as any, "s1")!.history,
    ).toHaveLength(4);
  });

  it("uses the session's own reported count, whatever tab is active", async () => {
    // §五.20: this thunk must never resolve the visible session itself. The view that shows a
    // session owns both writing this number and clearing it (see the useAutoScroll cleanup), so
    // the active tab is irrelevant here — a background session's view has already zeroed it.
    const store = storeWithWindow(12, 5, { activeSessionId: "s2" });
    await run(
      store,
      reconcilePaginationAfterPersist({
        sessionId: "s1",
        savedRevision: 3,
        totalHistoryCount: 10 + 12,
      }),
    );
    expect(
      selectSessionById(store.getState() as any, "s1")!.history,
    ).toHaveLength(5);
  });

  it("does not trim at all while the reply is still streaming", async () => {
    const store = storeWithWindow(12, 8);
    store.dispatch({
      type: "sessions/beginSessionStream",
      payload: {
        sessionId: "s1",
        requestId: "r1",
        aborter: new AbortController(),
      },
    } as any);

    await run(
      store,
      reconcilePaginationAfterPersist({
        sessionId: "s1",
        savedRevision: 3,
        totalHistoryCount: 10 + 12,
      }),
    );
    expect(
      selectSessionById(store.getState() as any, "s1")!.history,
    ).toHaveLength(12);
  });
});
