import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import { generateSessionTitle } from "./sessionTitle";

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

type StoreOptions = {
  title?: string;
  history?: ChatHistoryItemWithMessageId[];
  disableSessionTitles?: boolean;
  model?: boolean;
  catalogTitle?: string;
  /** Overrides the serialized `modelsByRole.chat` list. */
  chatModels?: any[];
  /** Overrides the profile-level (global) `selectedModelByRole.chat`. */
  globalChatModelTitle?: string;
  /** Overrides the target session's own model choice. */
  sessionChatModelTitle?: string;
};

function makeStore(options: StoreOptions = {}) {
  const {
    title = NEW_SESSION_TITLE,
    history = [
      item("u1", "user", "how do I parse JSON"),
      item("a1", "assistant", "use JSON.parse"),
    ],
    disableSessionTitles = false,
    model = true,
    catalogTitle,
    chatModels,
    globalChatModelTitle,
    sessionChatModelTitle = "gpt-4o",
  } = options;

  const s1 = initialSessionRuntime("s1", title, {
    history,
    chatModelTitle: sessionChatModelTitle,
    mode: "agent",
  });

  return createMockStore({
    sessions: {
      activeSessionId: "s2",
      tabOrder: ["s1", "s2"],
      tabDescriptors: {
        s1: { sessionId: "s1", title, loadState: "loaded" },
        s2: { sessionId: "s2", title: "Other", loadState: "loaded" },
      },
      sessionsById: {
        s1,
        s2: initialSessionRuntime("s2", "Other", {
          history: [item("u2", "user", "x")],
        }),
      },
    },
    sessionCatalog: {
      allSessionMetadata: catalogTitle
        ? [
            {
              sessionId: "s1",
              title: catalogTitle,
              dateCreated: "2026-01-01T00:00:00.000Z",
              workspaceDirectory: "/w",
            },
          ]
        : [],
      lastSessionId: "s1",
      isLoading: false,
    },
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        disableSessionTitles,
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat:
            chatModels ??
            (model
              ? [
                  {
                    title: "gpt-4o",
                    provider: "openai",
                    model: "gpt-4o",
                  } as any,
                ]
              : []),
        },
        selectedModelByRole: {
          ...INITIAL_CONFIG_SLICE.config.selectedModelByRole,
          chat: globalChatModelTitle
            ? ({
                title: globalChatModelTitle,
                provider: "openai",
                model: globalChatModelTitle,
              } as any)
            : null,
        },
      },
    },
  });
}

function session(store: ReturnType<typeof makeStore>, sessionId = "s1") {
  return (store.getState() as any).sessions.sessionsById[sessionId];
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("generateSessionTitle", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("describes the session and persists the new title", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const title = await run(store, generateSessionTitle({ sessionId: "s1" }));

    expect(title).toBe("Session summary");
    expect(request).toHaveBeenCalledWith(
      "chatDescriber/describe",
      expect.objectContaining({ text: expect.stringContaining("JSON.parse") }),
    );
    expect(session(store).title).toBe("Session summary");
    expect((store.getState() as any).sessions.tabDescriptors["s1"].title).toBe(
      "Session summary",
    );
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
    // The active session is untouched.
    expect(session(store, "s2").title).toBe("Other");
  });

  it("updates the catalog entry when one exists", async () => {
    const store = makeStore({ catalogTitle: NEW_SESSION_TITLE });

    await run(store, generateSessionTitle({ sessionId: "s1" }));

    expect(
      (store.getState() as any).sessionCatalog.allSessionMetadata[0].title,
    ).toBe("Session summary");
  });

  it("does nothing when the session already has a custom title", async () => {
    const store = makeStore({ title: "My chat" });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    expect(
      await run(store, generateSessionTitle({ sessionId: "s1" })),
    ).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(session(store).title).toBe("My chat");
  });

  it("falls back to the first user message when titles are disabled", async () => {
    const store = makeStore({ disableSessionTitles: true });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const title = await run(store, generateSessionTitle({ sessionId: "s1" }));

    expect(request).not.toHaveBeenCalledWith(
      "chatDescriber/describe",
      expect.anything(),
    );
    expect(title).toContain("how do I parse JSON");
  });

  it("falls back to the first user message before the catalog", async () => {
    const store = makeStore({
      history: [item("u1", "user", "hi")],
      catalogTitle: "From history list",
    });

    expect(await run(store, generateSessionTitle({ sessionId: "s1" }))).toBe(
      "hi",
    );
  });

  it("falls back to the catalog title when the first message yields nothing", async () => {
    const store = makeStore({
      history: [item("u1", "user", "")],
      catalogTitle: "From history list",
    });

    expect(await run(store, generateSessionTitle({ sessionId: "s1" }))).toBe(
      "From history list",
    );
  });

  it("survives a describer failure without blocking the save", async () => {
    const store = makeStore();
    store.mockIdeMessenger.request = vi.fn(async (type: string) => {
      if (type === "chatDescriber/describe") {
        throw new Error("describer down");
      }
      return { status: "success", content: undefined, done: true };
    }) as any;

    const title = await run(store, generateSessionTitle({ sessionId: "s1" }));

    // Fallback to the first user message.
    expect(title).toContain("how do I parse JSON");
  });

  it("ignores an unknown session", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    expect(
      await run(store, generateSessionTitle({ sessionId: "nope" })),
    ).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("generateSessionTitle session isolation (方案.md §七.10)", () => {
  beforeEach(() => resetSessionSaveQueues());

  /**
   * The bug this freezes: session A completes in the background while tab B is
   * active. The describer must be told *which* session and *which* model, because
   * Core cannot look either of them up — it has no sessionsById and the global
   * `selectedModelByRole.chat` may belong to another tab.
   */
  it("binds the request to the target session and its own model", async () => {
    const store = makeStore({
      sessionChatModelTitle: "model-a",
      chatModels: [
        { title: "model-a", provider: "openai", model: "model-a" },
        { title: "model-b", provider: "openai", model: "model-b" },
      ],
      // The profile-level selection belongs to the *other* tab.
      globalChatModelTitle: "model-b",
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const otherBefore = JSON.stringify(session(store, "s2"));

    expect((store.getState() as any).sessions.activeSessionId).toBe("s2");

    const title = await run(store, generateSessionTitle({ sessionId: "s1" }));
    expect(title).toBe("Session summary");

    const describeCall = request.mock.calls.find(
      (call) => call[0] === "chatDescriber/describe",
    );
    expect(describeCall).toBeDefined();
    const payload = describeCall![1] as any;

    // Identity and model are explicit, and the model is A's — not B's global one.
    expect(payload.sessionId).toBe("s1");
    expect(payload.modelTitle).toBe("model-a");

    // Context comes from A's history (B's history holds a lone "x" message).
    const rendered = payload.messages
      .map((m: any) => JSON.stringify(m.content))
      .join("\n");
    expect(rendered).toContain("how do I parse JSON");
    expect(rendered).toContain("use JSON.parse");
    expect(rendered).not.toContain('"text":"x"');

    // Only A is retitled…
    expect(session(store, "s1").title).toBe("Session summary");
    // …and B is byte-for-byte untouched: title, history, dirty flag and
    // persistence state all survive the background title generation.
    expect(session(store, "s2").title).toBe("Other");
    expect(session(store, "s2").dirty).toBe(false);
    expect(session(store, "s2").history.map((i: any) => i.message.id)).toEqual([
      "u2",
    ]);
    expect(JSON.stringify(session(store, "s2"))).toBe(otherBefore);
  });
});
