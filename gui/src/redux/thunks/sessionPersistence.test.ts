import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionSaveQueues, saveSession } from "./sessionPersistence";

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
