import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";
import type { InputModifiers } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import { resetSessionStreamCheckpoints } from "./sessionStreams";
import { resetSessionStreamRunner } from "./sessionTools";
import { submitSessionInput } from "./sessionSubmit";

const EDITOR_STATE: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "hello world" }],
    },
  ],
};

const MODIFIERS: InputModifiers = { useCodebase: false, noContext: true };

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
  history?: ChatHistoryItemWithMessageId[];
  truncated?: boolean;
  loadedOffset?: number;
  model?: boolean;
};

function makeStore(options: StoreOptions = {}) {
  const {
    history = [item("u1", "user", "earlier"), item("a1", "assistant", "sure")],
    truncated = false,
    loadedOffset = 0,
    model = true,
  } = options;

  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history,
    mode: "agent",
    chatModelTitle: "gpt-4o",
    pagination: {
      truncated,
      loadedOffset,
      hasMore: truncated,
      loading: false,
      requestGeneration: 0,
      persistPending: false,
    },
  });
  const s2 = initialSessionRuntime("s2", "Chat 2", {
    history: [item("u2", "user", "other")],
  });

  return createMockStore({
    sessions: {
      activeSessionId: "s2",
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
          chat: model
            ? [
                {
                  title: "gpt-4o",
                  provider: "openai",
                  model: "gpt-4o",
                } as any,
              ]
            : [],
        },
      },
    },
  });
}

function session(store: ReturnType<typeof makeStore>, sessionId = "s1") {
  return (store.getState() as any).sessions.sessionsById[sessionId];
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<boolean>;
}

describe("submitSessionInput", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  it("appends the user message and streams the reply into the target session", async () => {
    const store = makeStore();

    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "s1",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
        }),
      ),
    ).toBe(true);

    const target = session(store);
    const userItem = target.history.at(-2);
    const assistantItem = target.history.at(-1);
    expect(userItem.message.role).toBe("user");
    expect(JSON.stringify(userItem.message.content)).toContain("hello world");
    expect(assistantItem.message.role).toBe("assistant");
    expect(assistantItem.message.content).toBe("This is a test");
    expect(target.stream).toEqual({ status: "idle" });
    expect(target.persistence?.revision).toBeGreaterThan(0);
    // The active tab is untouched.
    expect(session(store, "s2").history).toHaveLength(1);
  });

  it("persists the user submit boundary immediately", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
  });

  it("replaces the message at index and truncates the tail on resend", async () => {
    const store = makeStore({
      history: [
        item("u1", "user", "first"),
        item("a1", "assistant", "answer"),
        item("u2", "user", "second"),
        item("a2", "assistant", "answer 2"),
      ],
    });

    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        index: 2,
      }),
    );

    const target = session(store);
    expect(target.history).toHaveLength(4);
    expect(target.history[0].message.content).toBe("first");
    expect(target.history[1].message.content).toBe("answer");
    expect(target.history[2].message.role).toBe("user");
    expect(JSON.stringify(target.history[2].message.content)).toContain(
      "hello world",
    );
    expect(target.history[3].message.role).toBe("assistant");
    expect(target.history[3].message.content).toBe("This is a test");
  });

  it("carries attachments as a trailing text part and metadata chips", async () => {
    const store = makeStore();

    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        attachments: [
          { name: "a.ts", path: "file:///a.ts", content: "const a = 1;" },
        ],
      }),
    );

    const userItem = session(store).history.at(-2);
    const parts = userItem.message.content as any[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.at(-1).text).toContain('<file_content path="file:///a.ts">');
    expect(userItem.message.metadata?.attachments).toEqual([
      { name: "a.ts", path: "file:///a.ts" },
    ]);
  });

  it("loads the full history before sending when the window is truncated", async () => {
    const store = makeStore({ truncated: true, loadedOffset: 4 });
    store.mockIdeMessenger.responses["history/load"] = {
      history: [
        item("h1", "user", "head user"),
        item("h2", "assistant", "head answer"),
        item("h3", "user", "head user 2"),
        item("h4", "assistant", "head answer 2"),
      ],
    } as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );

    expect(request).toHaveBeenCalledWith("history/load", { id: "s1" });
    // 4 frozen head items + 2 loaded tail items + the new user/assistant pair.
    expect(session(store).history).toHaveLength(8);
    expect(session(store).history[0].message.content).toBe("head user");
  });

  it("replaces the clicked entry, not the merged bubble, in a merged window", async () => {
    // Audit §5 / 设计 test 10. The window holds a bubble that merged a raw
    // assistant run, so the two coordinate systems disagree: `u5` is window 1 but
    // disk 5. The replacement must land on `u5` and leave the bubble intact.
    const traced: ChatHistoryItemWithMessageId = {
      ...item("m3", "assistant", "merged"),
      mergedReplyProvenance: {
        sourceMessageIds: ["m3", "m4"],
        firstSourceMessageId: "m3",
        lastSourceMessageId: "m4",
      },
    };
    const disk = [
      item("m0", "user", "q0"),
      item("m1", "assistant", "a0"),
      item("m3", "assistant", "a1 part 1"),
      item("m4", "assistant", "a1 part 2"),
      item("u5", "user", "q2"),
      item("a6", "assistant", "a2"),
    ];
    const store = makeStore({
      history: [
        traced,
        item("u5", "user", "q2"),
        item("a6", "assistant", "a2"),
      ],
      truncated: true,
      loadedOffset: 2,
    });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      title: "Chat 1",
      workspaceDirectory: "ws",
      history: disk,
    } as any;

    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "s1",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
          index: 1,
        }),
      ),
    ).toBe(true);

    const target = session(store);
    // The 2-item frozen head + the merged bubble + the new user/assistant pair.
    expect(target.history).toHaveLength(5);
    expect(target.history[0].message.content).toBe("q0");
    expect(target.history[1].message.content).toBe("a0");
    // The merged bubble is untouched — same identity, same content. (Its
    // runtime provenance may already be gone: the send is a save boundary, and a
    // successful save legitimately clears it — 设计 §2.3.)
    expect(target.history[2].message.id).toBe("m3");
    expect(target.history[2].message.content).toBe("merged");
    // The clicked user item and the tail it replaced are gone; the new pair is in.
    expect(target.history[3].message.role).toBe("user");
    expect(JSON.stringify(target.history[3].message.content)).toContain(
      "hello world",
    );
    expect(target.history[4].message.role).toBe("assistant");
    expect(target.history[4].message.content).toBe("This is a test");
    expect(
      target.history.some(
        (h: ChatHistoryItemWithMessageId) => h.message.id === "a6",
      ),
    ).toBe(false);
  });

  it("aborts instead of appending when the click index is no longer loaded", async () => {
    // 方案.md §十二: a miss aborts explicitly. The old behaviour appended a new
    // turn, which silently turned a stale edit into a brand-new message.
    const store = makeStore({
      history: [item("u1", "user", "earlier"), item("a1", "assistant", "sure")],
      truncated: true,
      loadedOffset: 4,
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "s1",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
          index: 9,
        }),
      ),
    ).toBe(false);

    // Nothing was loaded, nothing was written.
    expect(session(store).history).toHaveLength(2);
    expect(request).not.toHaveBeenCalledWith("history/load", expect.anything());
  });

  it("is a no-op for an unknown session", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "nope",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
        }),
      ),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("surfaces a missing model as a failed send", async () => {
    const store = makeStore({ model: false });

    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "s1",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
        }),
      ),
    ).toBe(false);
    expect(session(store).stream.status).toBe("idle");
  });
});
