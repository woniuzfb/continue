import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { EMPTY_CONFIG } from "../slices/configSlice";
import { selectSessionById } from "../selectors/sessions";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { activateSessionTab } from "./sessionActivation";
import { resetSessionSaveQueues, saveSession } from "./sessionPersistence";
import { NO_MEASUREMENT } from "../util/sessionSaveIntent";

/**
 * 方案.md §7.5.4, the **persistence** half: the session's stable identity must survive a reload, and
 * a file written before the identity existed ("legacy title") may only be upgraded from a title that
 * names exactly one entry.
 *
 * Both halves are one contract: if a save dropped the ref, every reload would silently downgrade a
 * session to title-only, and the ambiguity the ref removes would come back on the next restart.
 */

const MODEL_A = { title: "model-a", provider: "openai", model: "a" };
const MODEL_A_ANTHROPIC = {
  title: "model-a",
  provider: "anthropic",
  model: "a",
};
const MODEL_B = { title: "model-b", provider: "openai", model: "b" };

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
  sessionOverrides: Parameters<typeof initialSessionRuntime>[2] = {},
  models: any[] = [MODEL_A, MODEL_B],
  /** `unloaded: true` builds a store with no runtime at all, so the disk load path runs. */
  { unloaded = false }: { unloaded?: boolean } = {},
) {
  const session = initialSessionRuntime("s1", "Chat 1", {
    history: [item("u1", "user", "hi"), item("a1", "assistant", "yo")],
    dirty: true,
    persistence: {
      state: "pending",
      revision: 1,
      persistedRevision: 0,
      hasPersistedBaseline: false,
    },
    ...sessionOverrides,
  });
  return createMockStore({
    sessions: unloaded
      ? {
          // The descriptor exists (the tab is open) but no runtime does, so `activateSessionTab`
          // takes the disk-load path this test is about.
          activeSessionId: undefined,
          tabOrder: ["s1"],
          tabDescriptors: {
            s1: { sessionId: "s1", title: "Chat 1", loadState: "unloaded" },
          },
          sessionsById: {},
        }
      : {
          activeSessionId: "s1",
          tabOrder: ["s1"],
          tabDescriptors: {
            s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
          },
          sessionsById: { s1: session },
        },
    config: {
      configError: undefined,
      loading: false,
      config: {
        ...EMPTY_CONFIG,
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: models },
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: null,
        },
        ui: { lazyLoadHistory: false },
      },
    } as any,
  });
}

async function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap();
}

/**
 * The `history/save` payload the store actually sent. Read off the recorded calls (a typed lookup
 * fights the spy's tuple types for no benefit — the message type is the only thing being matched).
 */
function savedPayload(request: { mock: { calls: any[][] } }): any {
  const call = request.mock.calls.find((entry) => entry[0] === "history/save");
  expect(call).toBeDefined();
  return call![1];
}

describe("the session's model ref round-trips through save and load (方案.md §7.5.4)", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("writes the ref next to the title", async () => {
    const store = makeStore({
      chatModelTitle: "model-a",
      chatModelRef: { title: "model-a", provider: "openai", model: "a" },
    });

    const request = vi.spyOn(store.mockIdeMessenger, "request");
    await run(
      store,
      saveSession({
        sessionId: "s1",
        reason: "MODEL_CHANGED",
        measurementIntent: NO_MEASUREMENT,
      }),
    );

    const payload = savedPayload(request);
    expect(payload.chatModelTitle).toBe("model-a");
    expect(payload.chatModelRef).toEqual({
      title: "model-a",
      provider: "openai",
      model: "a",
    });
  });

  it("omits the ref for a session that has no choice of its own", async () => {
    // No choice ⇒ the profile default applies. Writing a ref here would freeze today's default into
    // the session (and a save must never derive one from a title).
    const store = makeStore({
      chatModelTitle: undefined,
      chatModelRef: undefined,
    });

    const request = vi.spyOn(store.mockIdeMessenger, "request");
    await run(
      store,
      saveSession({
        sessionId: "s1",
        reason: "MODEL_CHANGED",
        measurementIntent: NO_MEASUREMENT,
      }),
    );

    expect(savedPayload(request).chatModelRef).toBeNull();
  });

  it("restores the persisted ref unchanged when the session is loaded again", async () => {
    // The disk response the save produced, fed back through the load path. The ref must come back
    // exactly as written — never re-derived from the title, which for a duplicated title would pick
    // the wrong entry.
    const store = makeStore(undefined, [MODEL_A, MODEL_A_ANTHROPIC], {
      unloaded: true,
    });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      title: "Chat 1",
      workspaceDirectory: "/w",
      mode: "agent",
      chatModelTitle: "model-a",
      chatModelRef: { title: "model-a", provider: "anthropic", model: "a" },
      history: [item("u1", "user", "hi"), item("a1", "assistant", "yo")],
    } as any;

    await run(store, activateSessionTab({ sessionId: "s1" }));

    expect(
      selectSessionById(store.getState() as any, "s1")?.chatModelRef,
    ).toEqual({ title: "model-a", provider: "anthropic", model: "a" });
  });

  it("keeps the ref identical across a save → load → save cycle", async () => {
    const store = makeStore(
      {
        chatModelTitle: "model-a",
        chatModelRef: { title: "model-a", provider: "anthropic", model: "a" },
      },
      [MODEL_A, MODEL_A_ANTHROPIC],
    );

    const request = vi.spyOn(store.mockIdeMessenger, "request");
    await run(
      store,
      saveSession({
        sessionId: "s1",
        reason: "MODEL_CHANGED",
        measurementIntent: NO_MEASUREMENT,
      }),
    );
    const firstPayload = savedPayload(request);

    // Reload that exact payload into a fresh session, then save again.
    const reloaded = makeStore(undefined, [MODEL_A, MODEL_A_ANTHROPIC], {
      unloaded: true,
    });
    reloaded.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      workspaceDirectory: "/w",
      history: firstPayload.history,
      title: firstPayload.title,
      mode: firstPayload.mode,
      chatModelTitle: firstPayload.chatModelTitle,
      chatModelRef: firstPayload.chatModelRef,
    } as any;
    const reloadedRequest = vi.spyOn(reloaded.mockIdeMessenger, "request");
    await run(reloaded, activateSessionTab({ sessionId: "s1" }));
    await run(
      reloaded,
      saveSession({
        sessionId: "s1",
        reason: "FLUSH",
        measurementIntent: NO_MEASUREMENT,
      }),
    );

    const secondPayload = savedPayload(reloadedRequest);
    expect(secondPayload.chatModelRef).toEqual(firstPayload.chatModelRef);
    expect(secondPayload.chatModelRef).toEqual({
      title: "model-a",
      provider: "anthropic",
      model: "a",
    });
  });
});

describe("legacy title-only sessions (方案.md §7.5.4)", () => {
  beforeEach(() => resetSessionSaveQueues());

  function legacyStore(models: any[]) {
    const store = makeStore(undefined, models, { unloaded: true });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      title: "Chat 1",
      workspaceDirectory: "/w",
      mode: "chat",
      // The pre-identity file: a title, no ref.
      chatModelTitle: "model-a",
      history: [item("u1", "user", "hi"), item("a1", "assistant", "yo")],
    } as any;
    return store;
  }

  it("upgrades the ref when the legacy title names exactly one entry", async () => {
    const store = legacyStore([MODEL_A, MODEL_B]);
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, activateSessionTab({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1");
    expect(session?.chatModelRef).toEqual({
      title: "model-a",
      provider: "openai",
      model: "a",
    });
    // The upgrade is runtime-only: it must not persist itself, so a config change can never leave a
    // wrong identity on disk.
    expect(
      request.mock.calls.some((entry: any[]) => entry[0] === "history/save"),
    ).toBe(false);
  });

  it("stays unresolved when the legacy title names several entries", async () => {
    const store = legacyStore([MODEL_A, MODEL_A_ANTHROPIC]);

    await run(store, activateSessionTab({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1");
    // No ref is invented: the title cannot prove which entry the session meant.
    expect(session?.chatModelRef).toBeUndefined();
    expect(session?.chatModelTitle).toBe("model-a");
  });

  it("stays unresolved when the legacy title no longer exists", async () => {
    const store = legacyStore([MODEL_B]);

    await run(store, activateSessionTab({ sessionId: "s1" }));

    const session = selectSessionById(store.getState() as any, "s1");
    expect(session?.chatModelRef).toBeUndefined();
  });
});
