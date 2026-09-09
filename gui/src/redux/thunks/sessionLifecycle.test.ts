import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "core";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import {
  bootstrapLastSession,
  ensureActiveSessionLoaded,
  releaseClosingSessionIfClean,
  deleteSessionRuntime,
  ensureSessionRuntime,
  openSessionTab,
  refreshSessionCatalog,
} from "./sessionLifecycle";
import { resetSessionStreamRunner } from "./sessionTools";

function item(
  id: string,
  role: "user" | "assistant",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role,
      content,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function diskSession(sessionId: string, title = "From disk"): Session {
  return {
    sessionId,
    title,
    workspaceDirectory: "/w",
    history: [item("d1", "user", "hi"), item("d2", "assistant", "hello")],
  } as Session;
}

function metadata(sessionId: string, title = "From disk") {
  return {
    sessionId,
    title,
    dateCreated: "2026-01-01T00:00:00.000Z",
    workspaceDirectory: "/w",
  };
}

type StoreOptions = {
  catalog?: { sessionId: string; title?: string }[];
  lastSessionId?: string;
  runtimes?: Record<string, ReturnType<typeof initialSessionRuntime>>;
  activeSessionId?: string;
  tabOrder?: string[];
  /** Rehydrated descriptors: present in tabOrder but with no runtime. */
  unloadedDescriptors?: string[];
};

function makeStore(options: StoreOptions = {}) {
  const {
    catalog = [],
    lastSessionId,
    runtimes = {},
    activeSessionId,
    tabOrder = [],
    unloadedDescriptors = [],
  } = options;

  const tabDescriptors = Object.fromEntries([
    ...Object.keys(runtimes).map((id) => [
      id,
      { sessionId: id, title: id, loadState: "loaded" as const },
    ]),
    ...unloadedDescriptors.map((id) => [
      id,
      { sessionId: id, title: id, loadState: "unloaded" as const },
    ]),
  ]);

  return createMockStore({
    sessions: {
      activeSessionId,
      tabOrder,
      tabDescriptors,
      sessionsById: runtimes,
    },
    sessionCatalog: {
      allSessionMetadata: catalog.map((entry) =>
        metadata(entry.sessionId, entry.title),
      ),
      lastSessionId,
      isLoading: false,
    },
  });
}

function sessions(store: ReturnType<typeof makeStore>) {
  return (store.getState() as any).sessions;
}

function catalog(store: ReturnType<typeof makeStore>) {
  return (store.getState() as any).sessionCatalog;
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("sessionLifecycle", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamRunner();
  });

  it("refreshes the global catalog", async () => {
    const store = makeStore();
    store.mockIdeMessenger.responses["history/list"] = [
      metadata("s1", "One"),
      metadata("s2", "Two"),
    ];

    await run(store, refreshSessionCatalog({}));

    expect(catalog(store).allSessionMetadata).toHaveLength(2);
    expect(catalog(store).isLoading).toBe(false);
  });

  it("opens a catalog-only session: descriptor, runtime, active, lastSessionId", async () => {
    const store = makeStore({ catalog: [{ sessionId: "s1" }] });
    store.mockIdeMessenger.responses["history/load"] = diskSession("s1");

    await run(store, openSessionTab({ sessionId: "s1" }));

    expect(sessions(store).activeSessionId).toBe("s1");
    expect(sessions(store).tabDescriptors["s1"].loadState).toBe("loaded");
    expect(sessions(store).sessionsById["s1"].history).toHaveLength(2);
    expect(sessions(store).sessionsById["s1"].title).toBe("From disk");
    expect(catalog(store).lastSessionId).toBe("s1");
  });

  it("reuses a hidden runtime instead of loading a second one", async () => {
    const runtime = initialSessionRuntime("s1", "Hidden", {
      history: [item("h1", "user", "kept")],
    });
    const store = makeStore({
      catalog: [{ sessionId: "s1" }],
      runtimes: { s1: runtime },
      tabOrder: ["s2"],
      activeSessionId: "s2",
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, openSessionTab({ sessionId: "s1" }));

    expect(sessions(store).activeSessionId).toBe("s1");
    expect(sessions(store).sessionsById["s1"].history[0].message.content).toBe(
      "kept",
    );
    expect(request).not.toHaveBeenCalledWith("history/load", expect.anything());
  });

  it("bootstraps the last session from the catalog", async () => {
    const store = makeStore({
      catalog: [{ sessionId: "s1" }],
      lastSessionId: "s1",
    });
    store.mockIdeMessenger.responses["history/load"] = diskSession("s1");

    await run(store, bootstrapLastSession());

    expect(sessions(store).activeSessionId).toBe("s1");
    expect(sessions(store).sessionsById["s1"].history).toHaveLength(2);
  });

  it("loads a rehydrated active descriptor from disk", async () => {
    // 方案.md §五.16: after rehydration the descriptor exists but is unloaded
    // and no runtime may exist yet.
    const store = makeStore({
      activeSessionId: "s1",
      tabOrder: ["s1", "s2"],
      unloadedDescriptors: ["s1", "s2"],
    });
    // Without `ui.lazyLoadHistory` the activation pipeline uses the full
    // `history/load` path; both paths must produce exactly one runtime.
    store.mockIdeMessenger.responses["history/load"] = diskSession("s1");

    await run(store, ensureActiveSessionLoaded());

    expect(sessions(store).activeSessionId).toBe("s1");
    expect(sessions(store).tabDescriptors["s1"].loadState).toBe("loaded");
    expect(sessions(store).sessionsById["s1"].history).toHaveLength(2);
    // The other restored tab stays untouched until it is activated.
    expect(sessions(store).sessionsById["s2"]).toBeUndefined();
  });

  it("falls back to bootstrap when no descriptor was rehydrated", async () => {
    const store = makeStore({
      catalog: [{ sessionId: "s1" }],
      lastSessionId: "s1",
    });
    store.mockIdeMessenger.responses["history/load"] = diskSession("s1");

    await run(store, ensureActiveSessionLoaded());

    expect(sessions(store).activeSessionId).toBe("s1");
    expect(sessions(store).sessionsById["s1"].history).toHaveLength(2);
  });

  it("creates a new empty session when there is nothing to restore", async () => {
    const store = makeStore();

    await run(store, bootstrapLastSession());

    const activeId = sessions(store).activeSessionId;
    expect(activeId).toBeTruthy();
    expect(sessions(store).sessionsById[activeId].history).toEqual([]);
    expect(sessions(store).tabOrder).toEqual([activeId]);
  });

  it("creates a new session when the last one no longer exists", async () => {
    const store = makeStore({
      catalog: [{ sessionId: "other" }],
      lastSessionId: "gone",
    });

    await run(store, bootstrapLastSession());

    const activeId = sessions(store).activeSessionId;
    expect(activeId).not.toBe("gone");
    expect(sessions(store).sessionsById[activeId].history).toEqual([]);
  });

  it("deletes a session without touching its neighbour", async () => {
    const s1 = initialSessionRuntime("s1", "One", {
      history: [item("a", "user", "x")],
    });
    const s2 = initialSessionRuntime("s2", "Two", {
      history: [item("b", "user", "y")],
    });
    const store = makeStore({
      catalog: [{ sessionId: "s1" }, { sessionId: "s2" }],
      runtimes: { s1, s2 },
      tabOrder: ["s1", "s2"],
      activeSessionId: "s1",
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    store.mockIdeMessenger.responses["history/delete"] = undefined;

    await run(store, deleteSessionRuntime({ sessionId: "s1" }));

    expect(request).toHaveBeenCalledWith("history/delete", { id: "s1" });
    expect(sessions(store).sessionsById["s1"]).toBeUndefined();
    expect(sessions(store).tabOrder).toEqual(["s2"]);
    expect(sessions(store).activeSessionId).toBe("s2");
    expect(sessions(store).sessionsById["s2"].history).toHaveLength(1);
    expect(
      catalog(store).allSessionMetadata.map((m: any) => m.sessionId),
    ).toEqual(["s2"]);
  });

  it("stops the deleted session's own stream first", async () => {
    const aborter = new AbortController();
    const s1 = initialSessionRuntime("s1", "One", {
      stream: { status: "streaming", requestId: "req-1", aborter },
    });
    const store = makeStore({
      catalog: [{ sessionId: "s1" }],
      runtimes: { s1 },
      tabOrder: ["s1"],
      activeSessionId: "s1",
    });
    store.mockIdeMessenger.responses["history/delete"] = undefined;

    await run(store, deleteSessionRuntime({ sessionId: "s1" }));

    expect(aborter.signal.aborted).toBe(true);
    expect(sessions(store).sessionsById["s1"]).toBeUndefined();
  });

  it("ensureSessionRuntime is a no-op when the runtime already exists", async () => {
    const store = makeStore({
      runtimes: { s1: initialSessionRuntime("s1", "One") },
      tabOrder: ["s1"],
      activeSessionId: "s1",
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, ensureSessionRuntime({ sessionId: "s1" }));

    expect(request).not.toHaveBeenCalled();
  });
});

describe("releaseClosingSessionIfClean", () => {
  it("releases a closed, clean and idle hidden owner", async () => {
    const runtime = initialSessionRuntime("s1", "One", {
      lifecycle: { closing: true },
    });
    // A closed tab has no descriptor and no tabOrder entry.
    const store = createMockStore({
      sessions: {
        activeSessionId: undefined,
        tabOrder: [],
        tabDescriptors: {},
        sessionsById: { s1: runtime },
      },
    });

    expect(
      await run(store, releaseClosingSessionIfClean({ sessionId: "s1" })),
    ).toBe(true);
    expect(sessions(store).sessionsById["s1"]).toBeUndefined();
  });

  it("keeps the owner while it streams, awaits approval, is dirty or still visible", async () => {
    const streaming = initialSessionRuntime("s1", "One", {
      lifecycle: { closing: true },
      stream: { status: "streaming", requestId: "req-1" },
    });
    const streamStore = createMockStore({
      sessions: {
        activeSessionId: undefined,
        tabOrder: [],
        tabDescriptors: {},
        sessionsById: { s1: streaming },
      },
    });
    expect(
      await run(streamStore, releaseClosingSessionIfClean({ sessionId: "s1" })),
    ).toBe(false);
    expect(sessions(streamStore).sessionsById["s1"]).toBeDefined();

    const dirty = initialSessionRuntime("s1", "One", {
      lifecycle: { closing: true },
      dirty: true,
    });
    const dirtyStore = createMockStore({
      sessions: {
        activeSessionId: undefined,
        tabOrder: [],
        tabDescriptors: {},
        sessionsById: { s1: dirty },
      },
    });
    expect(
      await run(dirtyStore, releaseClosingSessionIfClean({ sessionId: "s1" })),
    ).toBe(false);

    const visible = initialSessionRuntime("s1", "One", {
      lifecycle: { closing: true },
    });
    const visibleStore = makeStore({
      runtimes: { s1: visible },
      tabOrder: ["s1"],
      activeSessionId: "s1",
    });
    expect(
      await run(
        visibleStore,
        releaseClosingSessionIfClean({ sessionId: "s1" }),
      ),
    ).toBe(false);
  });
});

describe("firstTurnItems hydration", () => {
  it("captures the disk first turn on a full load", async () => {
    const store = makeStore({ catalog: [{ sessionId: "s1" }] });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      title: "From disk",
      workspaceDirectory: "/w",
      history: [
        item("d1", "user", "first"),
        item("d2", "assistant", "reply"),
        item("d3", "user", "second"),
        item("d4", "assistant", "reply 2"),
      ],
    } as any;

    await run(store, openSessionTab({ sessionId: "s1" }));

    const runtime = sessions(store).sessionsById["s1"];
    expect(runtime.firstTurnItems.map((i: any) => i.message.content)).toEqual([
      "first",
      "reply",
    ]);
  });

  it("leaves firstTurnItems empty for a lazy window", async () => {
    const store = makeStore({ catalog: [{ sessionId: "s1" }] });
    (store.getState() as any).config.config.ui = { lazyLoadHistory: true };
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [
        item("t1", "user", "tail"),
        item("t2", "assistant", "tail reply"),
      ],
      hasMore: true,
      total: 20,
      session: {
        title: "From disk",
        mode: "agent",
        chatModelTitle: undefined,
        workspaceDirectory: "/w",
        contextMetrics: undefined,
      },
    } as any;

    await run(store, openSessionTab({ sessionId: "s1" }));

    expect(sessions(store).sessionsById["s1"].firstTurnItems).toEqual([]);
  });
});

describe("firstTurnItems from the paged response", () => {
  it("hydrates the disk first turn from loadPage", async () => {
    const store = makeStore({ catalog: [{ sessionId: "s1" }] });
    (store.getState() as any).config.config.ui = { lazyLoadHistory: true };
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [
        item("t1", "user", "tail"),
        item("t2", "assistant", "tail reply"),
      ],
      firstTurnItems: [
        item("f1", "user", "first"),
        item("f2", "assistant", "first reply"),
      ],
      hasMore: true,
      total: 20,
      session: {
        title: "From disk",
        mode: "agent",
        chatModelTitle: undefined,
        workspaceDirectory: "/w",
        contextMetrics: undefined,
      },
    } as any;

    await run(store, openSessionTab({ sessionId: "s1" }));

    expect(
      sessions(store).sessionsById["s1"].firstTurnItems.map(
        (i: any) => i.message.content,
      ),
    ).toEqual(["first", "first reply"]);
  });
});
