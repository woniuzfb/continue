import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistoryItem } from "core";
import { persistStore } from "redux-persist";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { updateConfig } from "./slices/configSlice";
import { EMPTY_CONFIG } from "./slices/configSlice";
import { setupStore } from "./store";
import {
  bootstrapLastSession,
  ensureActiveSessionLoaded,
} from "./thunks/sessionLifecycle";

/**
 * Real boot smoke test (方案.md §五.23 + §九): the GUI is normally only ever
 * exercised through the webview, so the riskiest seam — a v1 persisted snapshot
 * going through redux-persist, the v1→v2 migration and the rehydrate
 * normalization into the *real* store — was never executed outside a browser.
 *
 * This boots the production store (same reducer, same persist config, same
 * transforms) against a mocked host and then runs the real activation pipeline.
 */

const PERSIST_KEY = "persist:root";

function seedV1Snapshot() {
  const payload = {
    session: JSON.stringify({
      id: "s-active",
      lastSessionId: "s-last",
      title: "Boot title",
      mode: "chat",
    }),
    tabs: JSON.stringify({
      tabs: [
        { id: "t1", title: "Chat 1", isActive: false, sessionId: "s-other" },
        {
          id: "t2",
          title: "Boot title",
          isActive: true,
          sessionId: "s-active",
        },
      ],
    }),
    editModeState: JSON.stringify({
      returnToMode: "edit",
      lastNonEditSessionWasEmpty: true,
      codeToEdit: [],
      applyState: { streamId: "legacy-stream", status: "done" },
    }),
    _persist: JSON.stringify({ version: 1, rehydrated: true }),
  };
  localStorage.setItem(PERSIST_KEY, JSON.stringify(payload));
}

function diskItem(id: string, role: "user" | "assistant", content: string) {
  return {
    message: { id, role, content },
    contextItems: [],
  } as unknown as ChatHistoryItem;
}

function makeMessenger() {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responses["history/list"] = [
    {
      sessionId: "s-active",
      title: "Boot title",
      dateCreated: "2026-01-01T00:00:00.000Z",
      workspaceDirectory: "/w",
    },
    {
      sessionId: "s-last",
      title: "Last session",
      dateCreated: "2026-01-02T00:00:00.000Z",
      workspaceDirectory: "/w",
    },
  ] as any;
  ideMessenger.responses["history/loadPage"] = {
    items: [diskItem("m1", "user", "hello"), diskItem("m2", "assistant", "hi")],
    firstTurnItems: [diskItem("m0", "user", "first question")],
    // A truncated page: the disk first turn is what Phase 5 relies on.
    hasMore: true,
    total: 6,
    session: {
      title: "Last session",
      mode: "chat",
      chatModelTitle: undefined,
      workspaceDirectory: "/w",
      contextMetrics: undefined,
    },
  } as any;
  return ideMessenger;
}

async function boot() {
  const ideMessenger = makeMessenger();
  const store = setupStore({ ideMessenger });
  const persistor = persistStore(store);
  await new Promise<void>((resolve) => {
    const unsubscribe = persistor.subscribe(() => {
      if (persistor.getState().bootstrapped) {
        unsubscribe();
        resolve();
      }
    });
    if (persistor.getState().bootstrapped) {
      unsubscribe();
      resolve();
    }
  });
  return { store, persistor, ideMessenger };
}

describe("store boot with a persisted v1 snapshot", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("rehydrates the v2 tab projection and keeps runtime empty", async () => {
    seedV1Snapshot();
    const { store } = await boot();
    const state = store.getState() as any;

    expect(state.sessions.activeSessionId).toBe("s-active");
    expect(state.sessions.tabOrder).toEqual(["s-other", "s-active"]);
    expect(state.sessionCatalog.lastSessionId).toBe("s-last");

    // §五.23: a rehydrated descriptor never carries a runtime.
    expect(state.sessions.sessionsById).toEqual({});
    for (const descriptor of Object.values<any>(
      state.sessions.tabDescriptors,
    )) {
      expect(descriptor.loadState).toBe("unloaded");
    }
    // Runtime-only edit state must not survive the migration.
    expect(
      state.sessions.tabDescriptors["s-other"].persistedEditState.applyState,
    ).toBeUndefined();
  });

  it("bootstraps the last session into a loaded runtime without saving", async () => {
    seedV1Snapshot();
    const { store, ideMessenger } = await boot();
    const requestSpy = vi.spyOn(ideMessenger, "request");

    // The real app only reaches the paged path once config is loaded.
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        ui: { lazyLoadHistory: true, lazyLoadHistoryInitialCount: 4 } as any,
      }),
    );

    await (store.dispatch(bootstrapLastSession()) as any).unwrap();

    const state = store.getState() as any;
    expect(state.sessions.activeSessionId).toBe("s-last");
    expect(state.sessions.tabDescriptors["s-last"].loadState).toBe("loaded");

    const runtime = state.sessions.sessionsById["s-last"];
    expect(runtime).toBeTruthy();
    expect(runtime.title).toBe("Last session");
    expect(runtime.history.map((item: any) => item.message.content)).toEqual([
      "hello",
      "hi",
    ]);
    // §五.5/§十三.4: a truncated page hydrates the disk first turn from the
    // response instead of recomputing it from the window.
    expect(runtime.firstTurnItems).toHaveLength(1);
    expect(runtime.firstTurnItems[0].message.content).toBe("first question");
    expect(runtime.pagination.truncated).toBe(true);
    expect(runtime.pagination.loadedOffset).toBe(4);
    expect(runtime.pagination.totalCount).toBe(6);
    expect(runtime.dirty).toBe(false);

    // Activation must never persist (方案.md §五.16): no history/save, no
    // config/updateSelectedModel.
    const messageTypes = requestSpy.mock.calls.map(([type]) => type);
    expect(messageTypes).not.toContain("history/save");
    expect(messageTypes).not.toContain("config/updateSelectedModel");
  });

  it("loads the rehydrated active tab through the startup entry point", async () => {
    seedV1Snapshot();
    const { store } = await boot();
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        ui: { lazyLoadHistory: true, lazyLoadHistoryInitialCount: 4 } as any,
      }),
    );

    // This is exactly what ParallelListeners does after the config
    // round-trip: resolve the tab to open at that moment, not at first render.
    await (store.dispatch(ensureActiveSessionLoaded()) as any).unwrap();

    const state = store.getState() as any;
    expect(state.sessions.activeSessionId).toBe("s-active");
    expect(state.sessions.tabDescriptors["s-active"].loadState).toBe("loaded");
    expect(state.sessions.sessionsById["s-active"].history).toHaveLength(2);
    // A restored tab that is not visible is not loaded yet.
    expect(state.sessions.sessionsById["s-other"]).toBeUndefined();
  });

  it("runs the v0 migration chain in the real store", async () => {
    // No `_persist` at all: redux-persist treats it as version -1, so both the
    // "0" (v0 -> v1) and the "2" (v1 -> v2) migrations must run in order.
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: JSON.stringify({
          sessionId: "s0",
          defaultModelTitle: "gpt-4",
        }),
      }),
    );

    const { store } = await boot();
    const state = store.getState() as any;

    expect(state.sessions.activeSessionId).toBe("s0");
    expect(state.sessions.tabOrder).toEqual(["s0"]);
    expect(state.sessions.tabDescriptors["s0"].loadState).toBe("unloaded");
    expect(state.sessions.sessionsById).toEqual({});
  });

  it("creates a fresh session when the persisted catalog is empty", async () => {
    localStorage.clear();
    const { store } = await boot();
    await (store.dispatch(bootstrapLastSession()) as any).unwrap();

    const state = store.getState() as any;
    const activeSessionId = state.sessions.activeSessionId;
    expect(activeSessionId).toBeTruthy();
    expect(state.sessions.sessionsById[activeSessionId]).toBeTruthy();
    expect(state.sessions.sessionsById[activeSessionId].history).toEqual([]);
  });
});
