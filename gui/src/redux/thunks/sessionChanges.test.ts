import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { resetSessionSaveQueues } from "./sessionPersistence";
import {
  deleteSessionTurn,
  setActiveSessionModeAndSave,
  setActiveSessionReasoningAndSave,
  setSessionChatModelAndSave,
  truncateSessionHistoryAfter,
} from "./sessionChanges";

function item(
  id: string,
  role: "user" | "assistant",
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role,
      content: id,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function makeStore(history: ChatHistoryItemWithMessageId[] = []) {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    mode: "chat",
    history,
    dirty: true,
  });
  const s2 = initialSessionRuntime("s2", "Chat 2", { mode: "agent" });
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1", "s2"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        s2: { sessionId: "s2", title: "Chat 2", loadState: "loaded" },
      },
      sessionsById: { s1, s2 },
    },
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat: [
            { title: "gpt-4o", provider: "openai", model: "gpt-4o" } as any,
          ],
        },
      },
    },
  });
}

function session(store: ReturnType<typeof makeStore>, id = "s1") {
  return (store.getState() as any).sessions.sessionsById[id];
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("session change saves", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("saves on a mode change for the active session", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, setActiveSessionModeAndSave({ mode: "plan" }));

    expect(session(store).mode).toBe("plan");
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
  });

  it("saves on a reasoning change", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, setActiveSessionReasoningAndSave({ enabled: true }));

    expect(session(store).hasReasoningEnabled).toBe(true);
    // 方案.md §七.8: an explicit choice is persisted with its source, so a
    // reload does not silently fall back to the derived default.
    expect(session(store).reasoningPreferenceSource).toBe("explicit");
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({
          sessionId: "s1",
          hasReasoningEnabled: true,
          reasoningPreferenceSource: "explicit",
        }),
      );
    });
  });

  it("records a user model choice on the target session and projects it", async () => {
    const store = makeStore();

    await run(
      store,
      setSessionChatModelAndSave({
        sessionId: "s1",
        chatModelTitle: "gpt-4o",
      }),
    );

    expect(session(store).chatModelTitle).toBe("gpt-4o");
    expect(
      (store.getState() as any).config.activeSessionModelProjection?.title,
    ).toBe("gpt-4o");
    // A background session's choice is not projected onto the active UI.
    await run(
      store,
      setSessionChatModelAndSave({
        sessionId: "s2",
        chatModelTitle: "gpt-4o",
      }),
    );
    expect(
      (store.getState() as any).config.activeSessionModelProjection?.title,
    ).toBe("gpt-4o");
    expect(session(store, "s2").chatModelTitle).toBe("gpt-4o");
  });
});

// ── 方案.md §七.2: content mutations are their own save boundaries ─────────

describe("delete / truncate content mutations", () => {
  beforeEach(() => resetSessionSaveQueues());

  function historyStore() {
    return makeStore([
      item("u1", "user"),
      item("a1", "assistant"),
      item("u2", "user"),
      item("a2", "assistant"),
      item("u3", "user"),
      item("a3", "assistant"),
    ]);
  }

  it("saves immediately when a turn is deleted", async () => {
    const store = historyStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, deleteSessionTurn({ sessionId: "s1", messageId: "u2" }));

    // The whole turn goes, not just the one item.
    expect(session(store).history.map((i: any) => i.message.id)).toEqual([
      "u1",
      "a1",
      "u3",
      "a3",
    ]);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({
          sessionId: "s1",
          history: [
            expect.objectContaining({
              message: expect.objectContaining({ id: "u1" }),
            }),
            expect.objectContaining({
              message: expect.objectContaining({ id: "a1" }),
            }),
            expect.objectContaining({
              message: expect.objectContaining({ id: "u3" }),
            }),
            expect.objectContaining({
              message: expect.objectContaining({ id: "a3" }),
            }),
          ],
        }),
      );
    });
  });

  it("saves immediately when the history is truncated to a message", async () => {
    const store = historyStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(
      store,
      truncateSessionHistoryAfter({ sessionId: "s1", messageId: "a1" }),
    );

    // The kept prefix plus a regenerated, addressable assistant placeholder.
    const ids = session(store).history.map((i: any) => i.message.id);
    expect(ids.slice(0, 2)).toEqual(["u1", "a1"]);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toBeTruthy();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
  });

  it("keeps the mutation dirty when the save fails", async () => {
    const store = historyStore();
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "error",
      error: "disk full",
      errorCode: "SESSION_SAVE_FAILED",
      done: true,
    }) as any;

    await run(store, deleteSessionTurn({ sessionId: "s1", messageId: "u1" }));
    await vi.waitFor(() => {
      expect(session(store).persistence?.state).toBe("failed");
    });

    expect(session(store).dirty).toBe(true);
    expect(session(store).history.map((i: any) => i.message.id)).toEqual([
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
  });

  it("coalesces repeated deletions into the latest snapshot", async () => {
    const store = historyStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, deleteSessionTurn({ sessionId: "s1", messageId: "a3" }));
    await run(store, deleteSessionTurn({ sessionId: "s1", messageId: "a2" }));

    expect(session(store).history.map((i: any) => i.message.id)).toEqual([
      "u1",
      "a1",
    ]);
    // The last write must describe the final history, never a stale snapshot.
    await vi.waitFor(() => {
      expect(session(store).persistence?.state).toBe("clean");
    });
    const lastCall = request.mock.calls.at(-1)![1] as any;
    expect(lastCall.history.map((i: any) => i.message.id)).toEqual([
      "u1",
      "a1",
    ]);
  });
});
