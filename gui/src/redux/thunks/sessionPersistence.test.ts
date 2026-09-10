import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { selectSessionById } from "../selectors/sessions";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  deleteCompactionByMessageId,
  initialSessionRuntime,
  markSessionDirty,
} from "../slices/sessionsSlice";
import { loadMoreHistory } from "./sessionPaging";
import {
  resetSessionSaveQueues,
  retrySessionSave,
  saveSession,
} from "./sessionPersistence";

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

function makeStore(
  overrides: Parameters<typeof initialSessionRuntime>[2] = {},
  ui: Record<string, unknown> = {},
) {
  const session = initialSessionRuntime("s1", "Chat 1", {
    history: [item("u1", "user", "hi"), item("a1", "assistant", "yo")],
    dirty: true,
    persistence: {
      state: "pending",
      revision: 2,
      persistedRevision: 0,
      hasPersistedBaseline: false,
    },
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
    ...overrides,
  });
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1: session },
    },
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: { ...INITIAL_CONFIG_SLICE.config, ui },
    } as any,
  });
}

async function run(store: ReturnType<typeof makeStore>, thunk: any) {
  const action = store.dispatch(thunk);
  return (action as any).unwrap();
}

describe("sessionPersistence.saveSession", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("saves the runtime snapshot and marks the session persisted", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    expect(request).toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({
        sessionId: "s1",
        title: "Chat 1",
        historyTruncated: true,
        historyLoadedOffset: 4,
      }),
    );
    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.persistence).toMatchObject({
      state: "clean",
      revision: 2,
      persistedRevision: 2,
      hasPersistedBaseline: true,
    });
    expect(session.dirty).toBe(false);
    expect(session.pagination.persistPending).toBe(false);
  });

  it("keeps dirty and records the error code when the save fails", async () => {
    const store = makeStore();
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "error",
      error: "frozen head missing",
      errorCode: "TRUNCATED_BASELINE_MISSING",
      done: true,
    }) as any;

    await expect(
      run(store, saveSession({ sessionId: "s1", reason: "test" })),
    ).rejects.toThrow("frozen head missing");

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.persistence).toMatchObject({
      state: "failed",
      error: {
        code: "TRUNCATED_BASELINE_MISSING",
        message: "frozen head missing",
      },
    });
    expect(session.dirty).toBe(true);
    expect(session.pagination.persistPending).toBe(true);
  });

  it("clears the failure only when a retry succeeds", async () => {
    const store = makeStore();
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "error",
      error: "disk full",
      errorCode: "SESSION_SAVE_FAILED",
      done: true,
    }) as any;
    await expect(
      run(store, saveSession({ sessionId: "s1", reason: "test" })),
    ).rejects.toThrow("disk full");
    expect(
      selectSessionById(store.getState() as any, "s1")!.persistence?.state,
    ).toBe("failed");

    // A successful retry clears the error and recomputes clean/pending
    // (方案.md §七.7).
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "success",
      content: { firstTurnItems: [], totalHistoryCount: 2 },
      done: true,
    }) as any;
    await run(store, retrySessionSave({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.persistence?.state).toBe("clean");
    expect(session.persistence?.error).toBeUndefined();
    expect(session.dirty).toBe(false);
  });

  it("coalesces concurrent saves into at most one extra write", async () => {
    const store = makeStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn().mockImplementation(async () => {
      await gate;
      return { status: "success", content: undefined, done: true };
    });
    store.mockIdeMessenger.request = request as any;

    const first = run(store, saveSession({ sessionId: "s1", reason: "a" }));
    const second = run(store, saveSession({ sessionId: "s1", reason: "b" }));
    release();
    await Promise.all([first, second]);

    expect(request.mock.calls.length).toBeLessThanOrEqual(2);
    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.persistence?.state).toBe("clean");
  });

  it("does not roll back a revision bumped while the save was in flight", async () => {
    const store = makeStore();
    const before = selectSessionById(store.getState() as any, "s1")!;
    expect(before.persistence?.revision).toBe(2);

    // Hold the save open so a new change can arrive while it is in flight.
    let resolveSave: ((value: any) => void) | undefined;
    store.mockIdeMessenger.request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    ) as any;

    const save = run(store, saveSession({ sessionId: "s1", reason: "test" }));
    await vi.waitFor(() => {
      expect(resolveSave).toBeDefined();
    });

    // A stream chunk / tool result arrives during the request.
    store.dispatch(markSessionDirty({ sessionId: "s1" }));
    expect(
      selectSessionById(store.getState() as any, "s1")!.persistence?.revision,
    ).toBe(3);

    resolveSave!({
      status: "error",
      error: "disk full",
      errorCode: "SESSION_SAVE_FAILED",
      done: true,
    });
    await expect(save).rejects.toThrow("disk full");

    const session = selectSessionById(store.getState() as any, "s1")!;
    // The failure path must not restore the pre-request snapshot.
    expect(session.persistence).toMatchObject({
      state: "failed",
      revision: 3,
      persistedRevision: 0,
    });
    expect(session.persistence?.error?.message).toBe("disk full");
    expect(session.dirty).toBe(true);
  });

  it("keeps the newer revision when a save succeeds after a concurrent change", async () => {
    const store = makeStore();
    let resolveSave: ((value: any) => void) | undefined;
    store.mockIdeMessenger.request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    ) as any;

    const save = run(store, saveSession({ sessionId: "s1", reason: "test" }));
    await vi.waitFor(() => {
      expect(resolveSave).toBeDefined();
    });
    store.dispatch(markSessionDirty({ sessionId: "s1" }));

    resolveSave!({
      status: "success",
      content: { firstTurnItems: [], totalHistoryCount: 2 },
      done: true,
    });
    await save;

    const session = selectSessionById(store.getState() as any, "s1")!;
    // The response only confirms revision 2; the change made during the save
    // (revision 3) must stay pending instead of being marked clean.
    expect(session.persistence).toMatchObject({
      state: "pending",
      revision: 3,
      persistedRevision: 2,
    });
    expect(session.dirty).toBe(true);
  });

  it("does not restore derived metadata from a stale save response", async () => {
    const store = makeStore({
      history: [
        item("u1", "user", "hi"),
        {
          ...item("a1", "assistant", "yo"),
          conversationSummary: "stale summary",
        },
      ],
      firstTurnItems: [item("u1", "user", "hi")],
      latestConversationSummary: {
        sourceMessageId: "a1",
        sourceAbsoluteIndex: 1,
        content: "stale summary",
      },
    });

    let resolveSave: ((value: any) => void) | undefined;
    store.mockIdeMessenger.request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    ) as any;

    const save = run(store, saveSession({ sessionId: "s1", reason: "test" }));
    await vi.waitFor(() => {
      expect(resolveSave).toBeDefined();
    });

    // The user deletes the compaction while the save is in flight: the runtime
    // summary and the carrier are cleared and a new save is queued.
    store.dispatch(
      deleteCompactionByMessageId({ sessionId: "s1", messageId: "a1" }),
    );
    // The content change must move the persistence counter, otherwise the
    // response below would still compare as "current".
    expect(
      selectSessionById(store.getState() as any, "s1")!.persistence?.revision,
    ).toBe(3);

    resolveSave!({
      status: "success",
      content: {
        firstTurnItems: [],
        totalHistoryCount: 2,
        latestConversationSummary: {
          sourceMessageId: "a1",
          sourceAbsoluteIndex: 1,
          content: "stale summary",
        },
      },
      done: true,
    });
    await save;

    const session = selectSessionById(store.getState() as any, "s1")!;
    // The response describes the pre-delete content; applying it would feed a
    // deleted summary to the Local Provider until the next save lands.
    expect(session.latestConversationSummary).toBeUndefined();
    expect(session.persistence?.state).toBe("pending");
  });

  it("is a no-op for a session that has no runtime", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, saveSession({ sessionId: "missing", reason: "test" }));

    expect(request).not.toHaveBeenCalled();
  });
});

describe("sessionPersistence.saveSession response handling", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("applies the authoritative count and summary from the save response", async () => {
    const store = makeStore();
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "success",
      content: {
        firstTurnItems: [
          {
            message: { id: "d1", role: "user", content: "first" },
            contextItems: [],
          },
          {
            message: { id: "d2", role: "assistant", content: "reply" },
            contextItems: [],
          },
        ],
        totalHistoryCount: 42,
        latestConversationSummary: {
          sourceMessageId: "a1",
          sourceAbsoluteIndex: 1,
          content: "summary text",
        },
      },
      done: true,
    }) as any;

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.pagination.totalCount).toBe(42);
    expect(session.firstTurnItems.map((item) => item.message.content)).toEqual([
      "first",
      "reply",
    ]);
    expect(session.latestConversationSummary).toEqual({
      sourceMessageId: "a1",
      sourceAbsoluteIndex: 1,
      content: "summary text",
    });
  });

  it("clears a stale first turn and summary when the response omits them", async () => {
    const store = makeStore({
      firstTurnItems: [item("old1", "user", "stale first turn")],
      latestConversationSummary: {
        sourceMessageId: "old-summary",
        sourceAbsoluteIndex: 3,
        content: "stale summary",
      },
    });
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "success",
      content: {
        // Authoritative: the session on disk has neither a first turn nor a
        // compaction anymore.
        firstTurnItems: [],
        totalHistoryCount: 0,
      },
      done: true,
    }) as any;

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.firstTurnItems).toEqual([]);
    expect(session.latestConversationSummary).toBeUndefined();
  });
});

// ── 方案.md §九.5/§九.7: send-time trim after a successful save ────────────

describe("sessionPersistence send-time trim reconciliation", () => {
  beforeEach(() => resetSessionSaveQueues());

  const LAZY_UI = {
    lazyLoadHistory: true,
    lazyLoadHistoryInitialCount: 4,
    lazyLoadHistoryPageSize: 4,
  };

  /**
   * 6 GUI items / 6 disk items (1:1), frozen head of 4, merged disk total 10.
   * The last user message opens a 2-item turn, so limit 4 wins over the turn.
   */
  function trimStore(
    overrides: Parameters<typeof initialSessionRuntime>[2] = {},
    ui: Record<string, unknown> = LAZY_UI,
  ) {
    return makeStore(
      {
        history: [
          item("u1", "user"),
          item("a1", "assistant"),
          item("u2", "user"),
          item("a2", "assistant"),
          item("u3", "user"),
          item("a3", "assistant"),
        ],
        persistence: {
          state: "pending",
          revision: 2,
          persistedRevision: 0,
          hasPersistedBaseline: false,
        },
        pagination: {
          truncated: true,
          loadedOffset: 4,
          totalCount: 10,
          loadedDiskCount: 6,
          hasMore: true,
          loading: false,
          requestGeneration: 0,
          persistPending: true,
        },
        ...overrides,
      },
      ui,
    );
  }

  function saveOk(store: ReturnType<typeof trimStore>, total = 10) {
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "success",
      content: { firstTurnItems: [], totalHistoryCount: total },
      done: true,
    }) as any;
  }

  it("releases the frozen head once the window is on disk", async () => {
    const store = trimStore();
    saveOk(store);

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual([
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    expect(session.pagination).toMatchObject({
      truncated: true,
      loadedOffset: 6,
      loadedDiskCount: 4,
      totalCount: 10,
      hasMore: true,
      loading: false,
      persistPending: false,
      requestGeneration: 1,
    });
  });

  it("keeps the current turn even when it is longer than the limit", async () => {
    // The last user opens a 5-item turn (thinking + tool bubbles), so the
    // limit of 4 must lose to the turn boundary (方案.md §九.5).
    const store = trimStore({
      history: [
        item("u1", "user"),
        item("a1", "assistant"),
        item("u2", "user"),
        item("a2", "assistant"),
        item("b2", "assistant"),
        item("c2", "assistant"),
        item("d2", "assistant"),
      ],
      pagination: {
        truncated: true,
        loadedOffset: 0,
        totalCount: 7,
        loadedDiskCount: 7,
        hasMore: true,
        loading: false,
        requestGeneration: 0,
        persistPending: true,
      },
    });
    saveOk(store, 7);

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id)).toEqual([
      "u2",
      "a2",
      "b2",
      "c2",
      "d2",
    ]);
    expect(session.pagination.loadedOffset).toBe(2);
    expect(session.pagination.loadedDiskCount).toBe(5);
  });

  it("does not trim when the save failed", async () => {
    const store = trimStore();
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "error",
      error: "disk full",
      errorCode: "SESSION_SAVE_FAILED",
      done: true,
    }) as any;

    await expect(
      run(store, saveSession({ sessionId: "s1", reason: "test" })),
    ).rejects.toThrow("disk full");

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.length).toBe(6);
    expect(session.pagination.loadedOffset).toBe(4);
    expect(session.pagination.persistPending).toBe(true);
  });

  it("does not trim when a newer revision arrived during the save", async () => {
    const store = trimStore();
    let resolveSave: ((value: any) => void) | undefined;
    store.mockIdeMessenger.request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    ) as any;

    const save = run(store, saveSession({ sessionId: "s1", reason: "test" }));
    await vi.waitFor(() => expect(resolveSave).toBeDefined());

    // A stream chunk / tool result lands while the request is in flight.
    store.dispatch(markSessionDirty({ sessionId: "s1" }));
    resolveSave!({
      status: "success",
      content: { firstTurnItems: [], totalHistoryCount: 10 },
      done: true,
    });
    await save;

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.length).toBe(6);
    expect(session.persistence?.state).toBe("pending");
  });

  it("does not trim while the session is streaming", async () => {
    // `stream.status` has no "aborting" value: `stopSessionStream` aborts the
    // controller instead of writing state (方案.md 已知限制 #43).
    const store = trimStore({
      stream: { status: "streaming", requestId: "req-1" } as any,
    });
    saveOk(store);

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    expect(
      selectSessionById(store.getState() as any, "s1")!.history.length,
    ).toBe(6);
  });

  it("does not trim while a tool approval is pending", async () => {
    const store = trimStore({ pendingApprovalCount: 2 });
    saveOk(store);

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    expect(
      selectSessionById(store.getState() as any, "s1")!.history.length,
    ).toBe(6);
  });

  it("does not trim when lazy loading is off", async () => {
    const store = trimStore({}, {});
    saveOk(store);

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    expect(
      selectSessionById(store.getState() as any, "s1")!.history.length,
    ).toBe(6);
  });

  it("trims a merged window whose stale loadedDiskCount does not match", async () => {
    // Bubble merge collapsed the raw page (8 disk items) into 6 GUI items. The
    // pre-save raw count must not veto the trim: the successful save rewrote the
    // disk tail with these 6 items, so `totalHistoryCount` is 4 + 6 = 10.
    const store = trimStore({
      pagination: {
        truncated: true,
        loadedOffset: 4,
        totalCount: 10,
        loadedDiskCount: 8,
        hasMore: true,
        loading: false,
        requestGeneration: 0,
        persistPending: true,
      },
    });
    saveOk(store, 10);

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.length).toBe(4);
    expect(session.pagination).toMatchObject({
      loadedOffset: 6,
      loadedDiskCount: 4,
      totalCount: 10,
    });
  });

  it("reconciles the paging cursor of a merged window even when no trim runs", async () => {
    // Same merged window, but the limit already covers it so the trim is
    // skipped. `loadMoreHistory` sends `loadedDiskCount` as the page offset, so
    // the stale raw count (8) would skip disk[2,4) and leave a hole.
    const store = trimStore(
      {
        pagination: {
          truncated: true,
          loadedOffset: 4,
          totalCount: 10,
          loadedDiskCount: 8,
          hasMore: true,
          loading: false,
          requestGeneration: 0,
          persistPending: true,
        },
      },
      {
        lazyLoadHistory: true,
        lazyLoadHistoryInitialCount: 8,
        lazyLoadHistoryPageSize: 4,
      },
    );
    saveOk(store, 10);
    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.length).toBe(6);
    expect(session.pagination.loadedDiskCount).toBe(6);

    const request = vi.fn().mockResolvedValue({
      status: "success",
      content: {
        items: [
          item("h1", "user"),
          item("h2", "assistant"),
          item("h3", "user"),
          item("h4", "assistant"),
        ],
        firstTurnItems: [],
        hasMore: false,
        total: 10,
        session: {},
      },
      done: true,
    });
    store.mockIdeMessenger.request = request as any;

    await run(store, loadMoreHistory({ sessionId: "s1" }));

    // offset 6 = the window's disk length; the 8-raw count would ask for 8.
    expect(request).toHaveBeenCalledWith(
      "history/loadPage",
      expect.objectContaining({ id: "s1", offset: 6 }),
    );
    // The window stays contiguous: the 4 frozen head items land above it.
    expect(
      selectSessionById(store.getState() as any, "s1")!.history.map(
        (i) => i.message.id,
      ),
    ).toEqual(["h1", "h2", "h3", "h4", "u1", "a1", "u2", "a2", "u3", "a3"]);
  });

  it("does not trim when the response contradicts the window accounting", async () => {
    const store = trimStore();
    // 4 (frozen head) + 6 (window) = 10, so 13 means the mapping is untrusted.
    saveOk(store, 13);

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    expect(
      selectSessionById(store.getState() as any, "s1")!.history.length,
    ).toBe(6);
  });

  it("pages from the trimmed cursor instead of the dropped head", async () => {
    const store = trimStore();
    saveOk(store);
    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    const request = vi.fn().mockResolvedValue({
      status: "success",
      content: {
        items: [item("old1", "user"), item("old2", "assistant")],
        firstTurnItems: [],
        hasMore: true,
        total: 10,
        session: {},
      },
      done: true,
    });
    store.mockIdeMessenger.request = request as any;

    await run(store, loadMoreHistory({ sessionId: "s1" }));

    // loadedDiskCount 4 was retained, so the next page starts 4 items back.
    expect(request).toHaveBeenCalledWith(
      "history/loadPage",
      expect.objectContaining({ id: "s1", offset: 4, limit: 4 }),
    );
    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.history.map((i) => i.message.id).slice(0, 2)).toEqual([
      "old1",
      "old2",
    ]);
    expect(session.pagination.loadedOffset).toBe(4);
  });

  it("keeps the frozen head intact on the save after a trim", async () => {
    const store = trimStore();
    saveOk(store);
    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    // The next save must describe the trimmed window against the *new* frozen
    // head, otherwise Core would rewrite the file with the tail only.
    const request = vi.fn().mockResolvedValue({
      status: "success",
      content: { firstTurnItems: [], totalHistoryCount: 10 },
      done: true,
    });
    store.mockIdeMessenger.request = request as any;

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    expect(request).toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({
        sessionId: "s1",
        historyTruncated: true,
        historyLoadedOffset: 6,
        history: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({ id: "u2" }),
          }),
        ]),
      }),
    );
    expect(
      (request.mock.calls[0][1] as any).history.map((i: any) => i.message.id),
    ).toEqual(["u2", "a2", "u3", "a3"]);
  });
});
