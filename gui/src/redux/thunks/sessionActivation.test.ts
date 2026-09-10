import { describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { selectSelectedChatModel } from "../slices/configSlice";
import { EMPTY_CONFIG } from "../slices/configSlice";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { buildRequestHistoryForSession } from "../util/requestHistory";
import { getSessionPage } from "./session";
import {
  activateSessionTab,
  closeSessionTab,
  createAndActivateSession,
  loadSessionRuntime,
  projectSessionModelToActiveUi,
} from "./sessionActivation";

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

const CHAT_MODEL = {
  title: "model-a",
  provider: "mock",
  model: "mock-model",
  contextLength: 1000,
} as any;

function makeStore(
  sessions: any,
  options: {
    lazy?: boolean;
    modelTitle?: string;
    models?: any[];
  } = {},
) {
  return createMockStore({
    sessions,
    config: {
      configError: undefined,
      loading: false,
      config: {
        ...EMPTY_CONFIG,
        modelsByRole: {
          ...EMPTY_CONFIG.modelsByRole,
          chat: options.models ?? [CHAT_MODEL],
        },
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: options.modelTitle ? CHAT_MODEL : null,
        },
        ui: {
          lazyLoadHistory: options.lazy ?? false,
          lazyLoadHistoryInitialCount: 4,
        },
      },
    } as any,
  });
}

function emptySessions() {
  return {
    activeSessionId: undefined,
    tabOrder: [],
    tabDescriptors: {},
    sessionsById: {},
  };
}

async function run(store: ReturnType<typeof makeStore>, thunk: any) {
  const action = store.dispatch(thunk);
  return (action as any).unwrap();
}

describe("loadSessionRuntime", () => {
  it("creates a runtime from the lazy first page and marks the tab loaded", async () => {
    const store = makeStore(
      {
        ...emptySessions(),
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "unloaded" },
        },
      },
      { lazy: true },
    );
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [item("u2", "user", "hi"), item("a2", "assistant", "yo")],
      hasMore: true,
      total: 6,
      session: { title: "Chat 1", mode: "chat", workspaceDirectory: "ws" },
    } as any;

    await run(store, loadSessionRuntime({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.title).toBe("Chat 1");
    expect(session.history.map((i) => i.message.id)).toEqual(["u2", "a2"]);
    expect(session.pagination).toMatchObject({
      truncated: true,
      loadedOffset: 4,
      totalCount: 6,
      loadedDiskCount: 2,
      hasMore: true,
    });
    expect((store.getState() as any).sessions.tabDescriptors.s1.loadState).toBe(
      "loaded",
    );
  });

  it("treats a legacy page response without firstTurnItems as unavailable, not as an empty first turn", async () => {
    const store = makeStore(
      {
        ...emptySessions(),
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "unloaded" },
        },
      },
      { lazy: true },
    );
    // A host older than this field omits it entirely. No cast is needed here:
    // the protocol types it as optional precisely for that case.
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [item("u2", "user", "hi"), item("a2", "assistant", "yo")],
      hasMore: true,
      total: 6,
      session: { title: "Chat 1", mode: "chat", workspaceDirectory: "ws" },
    };

    // The normalisation itself, asserted at its own layer: with two redundant
    // `?? []` guards in the pipeline, an end-to-end assertion alone would still
    // pass if either one were dropped.
    expect(
      (await getSessionPage(store.mockIdeMessenger, "s1", 4)).firstTurnItems,
    ).toEqual([]);

    await run(store, loadSessionRuntime({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    // Normalised to an empty array: never left `undefined` (the fast path reads
    // `.length` off it), and never read as "this session has no first turn".
    expect(session.firstTurnItems).toEqual([]);

    // The observable consequence: the send path must not build a reduced Local
    // Provider request from a window whose first turn was never delivered. It
    // falls back to a full load instead of guessing a new session.
    expect(
      buildRequestHistoryForSession(session, { localConversation: true }).kind,
    ).toBe("needs-full-history");
  });

  it("restores reasoning preference and the authoritative summary", async () => {
    const store = makeStore(
      {
        ...emptySessions(),
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "unloaded" },
        },
      },
      { lazy: true },
    );
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [item("u2", "user", "hi"), item("a2", "assistant", "yo")],
      firstTurnItems: [item("u1", "user", "first")],
      latestConversationSummary: {
        sourceMessageId: "a1",
        sourceAbsoluteIndex: 1,
        content: "compacted",
      },
      hasMore: true,
      total: 6,
      session: {
        title: "Chat 1",
        mode: "chat",
        workspaceDirectory: "ws",
        hasReasoningEnabled: true,
        reasoningPreferenceSource: "explicit",
      },
    } as any;

    await run(store, loadSessionRuntime({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.hasReasoningEnabled).toBe(true);
    expect(session.reasoningPreferenceSource).toBe("explicit");
    expect(session.latestConversationSummary).toEqual({
      sourceMessageId: "a1",
      sourceAbsoluteIndex: 1,
      content: "compacted",
    });
  });

  it("restores the disk metrics snapshot and recomputes only on activation", async () => {
    const store = makeStore(
      {
        ...emptySessions(),
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "unloaded" },
        },
      },
      { lazy: true, modelTitle: "model-a" },
    );
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [item("u1", "user", "hi")],
      firstTurnItems: [item("u1", "user", "hi")],
      hasMore: false,
      total: 1,
      session: {
        title: "Chat 1",
        mode: "chat",
        workspaceDirectory: "ws",
        contextMetrics: {
          didPrune: false,
          contextPercentage: 0.25,
          inputTokens: 25,
          contextLength: 100,
        },
      },
    } as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    // Loading alone restores the persisted snapshot without compiling.
    await run(store, loadSessionRuntime({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1")!;
    expect(session.contextMetrics?.contextPercentage).toBe(0.25);
    expect(request).not.toHaveBeenCalledWith(
      "llm/compileChat",
      expect.anything(),
    );

    // Activation has no comparable snapshot meta yet, so the gate recomputes
    // once and stores the identity for the next activation (方案.md §五.16).
    await run(store, activateSessionTab({ sessionId: "s1" }));
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "llm/compileChat",
        expect.anything(),
      );
    });
    await vi.waitFor(() => {
      const after = selectSessionById(store.getState() as any, "s1")!;
      expect(after.contextMetricsMeta?.modelIdentity).toBe("model-a");
    });
  });

  it("keeps the descriptor and creates no runtime when loading fails", async () => {
    const store = makeStore({
      ...emptySessions(),
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "unloaded" },
      },
    });
    store.mockIdeMessenger.responseHandlers["history/load"] = async () => {
      throw new Error("disk on fire");
    };

    await expect(
      run(store, loadSessionRuntime({ sessionId: "s1" })),
    ).rejects.toThrow("disk on fire");

    expect(selectSessionById(store.getState() as any, "s1")).toBeUndefined();
    expect((store.getState() as any).sessions.tabDescriptors.s1.loadState).toBe(
      "failed",
    );
  });
});

describe("activateSessionTab", () => {
  it("projects the session model without reloading a loaded tab", async () => {
    const session = initialSessionRuntime("s1", "Chat 1", {
      chatModelTitle: "model-a",
      history: [item("u1", "user", "hi")],
    });
    const store = makeStore({
      activeSessionId: undefined,
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1: session },
    });
    let loadedPage = false;
    store.mockIdeMessenger.responseHandlers["history/loadPage"] = async () => {
      loadedPage = true;
      return { items: [], hasMore: false, total: 0, session: {} } as any;
    };

    await run(store, activateSessionTab({ sessionId: "s1" }));

    expect((store.getState() as any).sessions.activeSessionId).toBe("s1");
    expect(loadedPage).toBe(false);
    // Projection is runtime-only: the user selection is untouched.
    expect(selectSelectedChatModel(store.getState() as any)?.title).toBe(
      "model-a",
    );
    expect(
      (store.getState() as any).config.config.selectedModelByRole.chat,
    ).toBeNull();
  });

  it("recomputes stale context metrics on activation", async () => {
    const store = makeStore(
      {
        activeSessionId: "s1",
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "One", loadState: "loaded" },
        },
        sessionsById: {
          // No contextMetrics snapshot: the gate must recompile on activation.
          s1: initialSessionRuntime("s1", "One", {
            history: [item("u1", "user", "hi")],
          }),
        },
      },
      { modelTitle: "model-a" },
    );
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, activateSessionTab({ sessionId: "s1" }));

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "llm/compileChat",
        expect.anything(),
      );
    });
  });

  it("does not project a slow activation that finished after a tab switch", async () => {
    const modelA = { ...CHAT_MODEL, title: "model-a" };
    const modelB = { ...CHAT_MODEL, title: "model-b" };
    const store = makeStore(
      {
        activeSessionId: "s1",
        tabOrder: ["s1", "s2"],
        tabDescriptors: {
          // A is unloaded (slow disk read), B is already loaded.
          s1: { sessionId: "s1", title: "A", loadState: "unloaded" },
          s2: { sessionId: "s2", title: "B", loadState: "loaded" },
        },
        sessionsById: {
          s2: initialSessionRuntime("s2", "B", {
            chatModelTitle: "model-b",
          }),
        },
      },
      { models: [modelA, modelB] },
    );

    let releaseA: (() => void) | undefined;
    store.mockIdeMessenger.responseHandlers["history/load"] = () =>
      new Promise((resolve) => {
        releaseA = () =>
          resolve({
            sessionId: "s1",
            title: "A",
            workspaceDirectory: "ws",
            history: [item("u1", "user", "hi")],
            chatModelTitle: "model-a",
          } as any);
      });

    // Click A (slow), then click B before A's disk read finishes.
    const activateA = run(store, activateSessionTab({ sessionId: "s1" }));
    await run(store, activateSessionTab({ sessionId: "s2" }));
    expect(
      (store.getState() as any).config.activeSessionModelProjection?.title,
    ).toBe("model-b");

    // A finishes last: the visible tab is still B, so the projection stays B.
    releaseA!();
    await activateA;

    const state = store.getState() as any;
    expect(state.sessions.activeSessionId).toBe("s2");
    expect(state.config.activeSessionModelProjection?.title).toBe("model-b");
  });

  it("loads an unloaded tab before projecting", async () => {
    const store = makeStore(
      {
        ...emptySessions(),
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "unloaded" },
        },
      },
      { lazy: true },
    );
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [item("u1", "user", "hi")],
      hasMore: false,
      total: 1,
      session: {
        title: "Chat 1",
        chatModelTitle: "model-a",
        workspaceDirectory: "ws",
      },
    } as any;

    await run(store, activateSessionTab({ sessionId: "s1" }));

    expect((store.getState() as any).sessions.activeSessionId).toBe("s1");
    expect(selectSessionById(store.getState() as any, "s1")).toBeDefined();
    expect(selectSelectedChatModel(store.getState() as any)?.title).toBe(
      "model-a",
    );
  });
});

describe("createAndActivateSession", () => {
  it("creates an empty runtime, descriptor and activates it", async () => {
    const store = makeStore(emptySessions());

    await run(
      store,
      createAndActivateSession({ origin: "new", sessionId: "n1" }),
    );

    const state = store.getState() as any;
    expect(state.sessions.activeSessionId).toBe("n1");
    expect(state.sessions.tabOrder).toEqual(["n1"]);
    expect(state.sessions.tabDescriptors.n1.loadState).toBe("loaded");
    expect(selectSessionById(store.getState() as any, "n1")!.history).toEqual(
      [],
    );
  });
});

describe("closeSessionTab", () => {
  function twoTabStore(sessionOverrides: any = {}) {
    return makeStore({
      activeSessionId: "s1",
      tabOrder: ["s1", "s2"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "One", loadState: "loaded" },
        s2: { sessionId: "s2", title: "Two", loadState: "loaded" },
      },
      sessionsById: {
        s1: initialSessionRuntime("s1", "One", sessionOverrides),
        s2: initialSessionRuntime("s2", "Two"),
      },
    });
  }

  it("activates the right neighbour and releases a clean idle owner", async () => {
    const store = twoTabStore();

    await run(store, closeSessionTab({ sessionId: "s1" }));

    const state = store.getState() as any;
    expect(state.sessions.tabOrder).toEqual(["s2"]);
    expect(state.sessions.activeSessionId).toBe("s2");
    expect(selectSessionById(store.getState() as any, "s1")).toBeUndefined();
  });

  it("keeps the runtime owner for a streaming tab", async () => {
    const store = twoTabStore({
      stream: { status: "streaming", requestId: "r1" },
    });

    await run(store, closeSessionTab({ sessionId: "s1" }));

    const state = store.getState() as any;
    expect(state.sessions.tabOrder).toEqual(["s2"]);
    expect(selectSessionById(store.getState() as any, "s1")).toBeDefined();
    expect(
      selectSessionById(store.getState() as any, "s1")!.lifecycle.closing,
    ).toBe(true);
  });

  function threeTabStore() {
    return makeStore({
      activeSessionId: "s1",
      tabOrder: ["s1", "s2", "s3"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "One", loadState: "loaded" },
        s2: { sessionId: "s2", title: "Two", loadState: "loaded" },
        s3: { sessionId: "s3", title: "Three", loadState: "loaded" },
      },
      sessionsById: {
        s1: initialSessionRuntime("s1", "One"),
        s2: initialSessionRuntime("s2", "Two"),
        s3: initialSessionRuntime("s3", "Three"),
      },
    });
  }

  it("closing an inactive middle tab keeps the visible tab", async () => {
    const store = threeTabStore();

    await run(store, closeSessionTab({ sessionId: "s2" }));

    const state = store.getState() as any;
    expect(state.sessions.tabOrder).toEqual(["s1", "s3"]);
    expect(state.sessions.activeSessionId).toBe("s1");
    expect(state.sessions.tabDescriptors.s2).toBeUndefined();
  });

  it("closing the inactive rightmost tab keeps the visible tab", async () => {
    const store = threeTabStore();

    await run(store, closeSessionTab({ sessionId: "s3" }));

    const state = store.getState() as any;
    expect(state.sessions.tabOrder).toEqual(["s1", "s2"]);
    expect(state.sessions.activeSessionId).toBe("s1");
  });

  it("closing an inactive unloaded/failed tab keeps the visible tab", async () => {
    const store = makeStore({
      activeSessionId: "s1",
      tabOrder: ["s1", "s2", "s3"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "One", loadState: "loaded" },
        s2: { sessionId: "s2", title: "Two", loadState: "unloaded" },
        s3: { sessionId: "s3", title: "Three", loadState: "failed" },
      },
      sessionsById: { s1: initialSessionRuntime("s1", "One") },
    });

    await run(store, closeSessionTab({ sessionId: "s2" }));
    await run(store, closeSessionTab({ sessionId: "s3" }));

    const state = store.getState() as any;
    expect(state.sessions.tabOrder).toEqual(["s1"]);
    expect(state.sessions.activeSessionId).toBe("s1");
  });

  it("clears the model projection when the last tab is closed", async () => {
    const store = makeStore({
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "One", loadState: "loaded" },
      },
      sessionsById: {
        s1: initialSessionRuntime("s1", "One", {
          chatModelTitle: "model-a",
        }),
      },
    });
    // The closed session's model is currently projected onto the UI.
    await run(store, activateSessionTab({ sessionId: "s1" }));
    expect(
      (store.getState() as any).config.activeSessionModelProjection?.title,
    ).toBe("model-a");

    await run(store, closeSessionTab({ sessionId: "s1" }));

    const state = store.getState() as any;
    // The new empty tab must not inherit the closed session's projection.
    expect(state.config.activeSessionModelProjection ?? null).toBeNull();
  });

  it("creates a new empty tab when the last one closes", async () => {
    const store = makeStore({
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "One", loadState: "loaded" },
      },
      sessionsById: { s1: initialSessionRuntime("s1", "One") },
    });

    await run(store, closeSessionTab({ sessionId: "s1" }));

    const state = store.getState() as any;
    expect(state.sessions.tabOrder).toHaveLength(1);
    expect(state.sessions.tabOrder[0]).not.toBe("s1");
    expect(state.sessions.activeSessionId).toBe(state.sessions.tabOrder[0]);
  });
});

describe("projectSessionModelToActiveUi", () => {
  it("falls back to the user selection when the session has no model", async () => {
    const store = makeStore(emptySessions(), { modelTitle: "model-a" });
    expect(selectSelectedChatModel(store.getState() as any)?.title).toBe(
      "model-a",
    );

    await run(
      store,
      projectSessionModelToActiveUi({
        sessionId: "s1",
        chatModelTitle: undefined,
      }),
    );

    // A cleared projection means "use the persisted user selection".
    expect(selectSelectedChatModel(store.getState() as any)?.title).toBe(
      "model-a",
    );
  });
});

describe("activateSessionTab does not save", () => {
  /**
   * 方案.md §七.11 / §十六: switching tabs is not a save boundary. Every content
   * mutation enqueues its own save (§七.2), so activation must not flush the
   * outgoing session — that was the Phase 1 transitional behaviour.
   */
  function twoTabStore() {
    const a = initialSessionRuntime("s1", "A", {
      history: [item("u1", "user"), item("a1", "assistant")],
      dirty: true,
      persistence: {
        state: "pending",
        revision: 3,
        persistedRevision: 2,
        hasPersistedBaseline: true,
      },
    });
    const b = initialSessionRuntime("s2", "B", {
      history: [item("u2", "user"), item("a2", "assistant")],
    });
    return makeStore({
      activeSessionId: "s1",
      tabOrder: ["s1", "s2"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "A", loadState: "loaded" },
        s2: { sessionId: "s2", title: "B", loadState: "loaded" },
      },
      sessionsById: { s1: a, s2: b },
    });
  }

  it("never flushes the outgoing session on a tab switch", async () => {
    const store = twoTabStore();
    // The activation pipeline may recompute context metrics; that is not a save.
    store.mockIdeMessenger.responses["llm/compileChat"] = {
      didPrune: false,
      contextPercentage: 0,
      inputTokens: 1,
      contextLength: 100,
    } as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, activateSessionTab({ sessionId: "s2" }));

    expect((store.getState() as any).sessions.activeSessionId).toBe("s2");
    expect(request.mock.calls.filter((c) => c[0] === "history/save")).toEqual(
      [],
    );
    // The outgoing session keeps its pending state — nothing was resolved.
    const a = selectSessionById(store.getState() as any, "s1")!;
    expect(a.dirty).toBe(true);
    expect(a.persistence?.revision).toBe(3);
    expect(a.persistence?.state).toBe("pending");
  });
});
