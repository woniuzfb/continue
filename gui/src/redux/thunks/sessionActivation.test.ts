import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { selectSelectedChatModel } from "../slices/configSlice";
import { EMPTY_CONFIG } from "../slices/configSlice";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
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
  options: { lazy?: boolean; modelTitle?: string } = {},
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
          chat: [CHAT_MODEL],
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
