import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";

/**
 * Pauses the submit thunk **after** the editor content has been resolved and before
 * the submitted turn is committed. That is the only place where a test can inject a
 * concurrent mutation of the same session's history (方案.md §七.3, Stage 2F 收口):
 * the real resolution is still used, only the return is gated.
 */
const contentGate: {
  armed: boolean;
  reached: boolean;
  release: (() => void) | undefined;
} = { armed: false, reached: false, release: undefined };

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  async (importOriginal) => {
    const actual =
      (await importOriginal()) as typeof import("../../components/mainInput/TipTapEditor/utils/resolveEditorContent");
    return {
      ...actual,
      resolveEditorContent: async (input: any) => {
        const resolved = await actual.resolveEditorContent(input);
        if (contentGate.armed) {
          contentGate.armed = false;
          contentGate.reached = true;
          await new Promise<void>((resolve) => {
            contentGate.release = resolve;
          });
        }
        return resolved;
      },
    };
  },
);

/** Arms the pause and returns helpers to wait for it and let it through. */
function pauseAfterContentResolution() {
  contentGate.armed = true;
  contentGate.reached = false;
  contentGate.release = undefined;
  return {
    async reached() {
      await vi.waitFor(() => expect(contentGate.reached).toBe(true));
    },
    release() {
      contentGate.release?.();
    },
  };
}
import type { InputModifiers } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  initialSessionRuntime,
  removeSessionRuntime,
  setSessionHistory,
  setSessionMainEditorAttachmentsRestore,
  updateHistoryItemByMessageId,
} from "../slices/sessionsSlice";
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
  firstTurnItems?: ChatHistoryItemWithMessageId[];
  latestConversationSummary?: {
    sourceMessageId: string;
    sourceAbsoluteIndex: number;
    content: string;
  };
  truncated?: boolean;
  loadedOffset?: number;
  model?: boolean;
  modelName?: string;
  hasPersistedBaseline?: boolean;
};

function makeStore(options: StoreOptions = {}) {
  const {
    history = [item("u1", "user", "earlier"), item("a1", "assistant", "sure")],
    firstTurnItems = [],
    latestConversationSummary,
    truncated = false,
    loadedOffset = 0,
    model = true,
    modelName = "gpt-4o",
    hasPersistedBaseline = false,
  } = options;

  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history,
    firstTurnItems,
    ...(latestConversationSummary ? { latestConversationSummary } : {}),
    mode: "agent",
    chatModelTitle: "gpt-4o",
    persistence: {
      state: "clean",
      revision: 0,
      persistedRevision: 0,
      hasPersistedBaseline,
    },
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
                  model: modelName,
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

/**
 * Holds the reply open so a test can observe the state **between** the submitted
 * turn and the terminal commit — that is the only way to attribute a
 * `conversationRevision` advance to the submit itself (Stage 2F).
 */
function deferredStream(store: ReturnType<typeof makeStore>) {
  let release: (() => void) | undefined;
  let iterated = false;
  store.mockIdeMessenger.llmStreamChat = async function* () {
    iterated = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    yield [{ role: "assistant", content: "late reply" } as any];
  } as any;
  return {
    async started() {
      await vi.waitFor(() => expect(iterated).toBe(true));
    },
    release() {
      release?.();
    },
  };
}

/** Text of a message whose content may be a string or a parts array. */
function textOf(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
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

  it("commits the turn before hydrating a lazy-loaded window", async () => {
    // A lazy-loaded window is hydrated from disk before the request goes out — but that is
    // a full `history/load` round trip plus the merge (measured: 1361.8ms on a real
    // session). The **commit** must not wait for it: the user's turn is a content version
    // the moment it is submitted, and the request plan hydrates afterwards.
    const store = makeStore({ truncated: true, loadedOffset: 4 });
    let releaseLoad: (() => void) | undefined;
    const original = store.mockIdeMessenger.request.bind(
      store.mockIdeMessenger,
    );
    (store.mockIdeMessenger as any).request = vi.fn(
      async (type: string, data: any) => {
        if (type === "history/load") {
          await new Promise<void>((resolve) => {
            releaseLoad = resolve;
          });
          return {
            status: "success",
            content: {
              history: [
                item("h1", "user", "head user"),
                item("h2", "assistant", "head answer"),
                item("h3", "user", "head user 2"),
                item("h4", "assistant", "head answer 2"),
                item("u1", "user", "earlier"),
                item("a1", "assistant", "sure"),
              ],
            },
            done: true,
          };
        }
        return original(type as any, data as any);
      },
    ) as any;

    const before = session(store).conversationRevision;
    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    await vi.waitFor(() => expect(releaseLoad).toBeDefined());

    // The turn is committed while the hydration is still in flight: bubble first, disk
    // read second — and the pending draft is already gone, so what the user sees is the
    // real bubble and not a "preparing" placeholder held back by the read.
    expect(session(store).conversationRevision).toBe(before + 1);
    expect(session(store).history.at(-2).message.role).toBe("user");
    expect(session(store).history.at(-1).message.role).toBe("assistant");
    expect(session(store).history).toHaveLength(4);
    expect(session(store).pendingSubmission).toBeUndefined();

    releaseLoad!();
    await pending;

    // …and the merge that follows is tail-preserving: the committed turn is still the end
    // of the window, on top of the frozen head.
    const history = session(store).history;
    expect(history[0].message.content).toBe("head user");
    expect(history.at(-2).message.role).toBe("user");
    expect(history.at(-1).message.content).toBe("This is a test");
    expect(history).toHaveLength(8);
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

  it("resolves an edit by identity even when the captured window index is stale", async () => {
    // Regression: an inline history bubble captures its `onEnter` once, when it
    // mounts, so its positional index goes stale as soon as the window is
    // trimmed or fully hydrated (a post-save trim, a full load). The identity
    // survives those, so it is re-resolved against the *current* window.
    const store = makeStore({ truncated: true, loadedOffset: 4 });
    store.mockIdeMessenger.responses["history/load"] = {
      history: [
        item("h1", "user", "head user"),
        item("h2", "assistant", "head answer"),
        item("h3", "user", "head user 2"),
        item("h4", "assistant", "head answer 2"),
      ],
    } as any;

    // `u1` is window index 0. A stale `index: 9` must be ignored, not honoured.
    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "s1",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
          targetMessageId: "u1",
          index: 9,
        }),
      ),
    ).toBe(true);

    const target = session(store);
    // 4 frozen head items + the new user/assistant pair; the replaced tail is gone.
    expect(target.history).toHaveLength(6);
    expect(target.history[4].message.role).toBe("user");
    expect(target.history[5].message.role).toBe("assistant");
    expect(
      target.history.some(
        (h: ChatHistoryItemWithMessageId) =>
          h.message.id === "u1" || h.message.id === "a1",
      ),
    ).toBe(false);
  });

  it("keeps a complete Local Provider first turn across repeated edits", async () => {
    const originalFirstTurn = [
      item("u1", "user", "original question"),
      item("a1", "assistant", "original answer with substantial context"),
    ];
    const store = makeStore({
      history: originalFirstTurn,
      firstTurnItems: originalFirstTurn,
      modelName: "openrouter:local-model",
      hasPersistedBaseline: true,
    });
    store.mockIdeMessenger.responseHandlers["history/save"] = async (
      payload: any,
    ) => ({
      firstTurnItems: payload.history,
      totalHistoryCount: payload.history.length,
    });
    store.mockIdeMessenger.responseHandlers["llm/compileChat"] = async (
      payload: any,
    ) => ({
      compiledChatMessages: payload.messages,
      didPrune: false,
      inputTokens: JSON.stringify(payload.messages).length,
      contextLength: 100_000,
      contextPercentage: JSON.stringify(payload.messages).length / 100_000,
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "s1",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
          targetMessageId: "u1",
        }),
      ),
    ).toBe(true);

    const firstReplacementId = session(store).history.find(
      (entry: ChatHistoryItemWithMessageId) => entry.message.role === "user",
    ).message.id;
    expect(firstReplacementId).not.toBe("u1");
    await vi.waitFor(() => {
      expect(
        session(store).firstTurnItems.some(
          (entry: ChatHistoryItemWithMessageId) =>
            entry.message.role === "assistant" &&
            entry.message.content === "This is a test",
        ),
      ).toBe(true);
    });

    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "s1",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
          targetMessageId: firstReplacementId,
        }),
      ),
    ).toBe(true);

    expect(
      session(store).firstTurnItems.some(
        (entry: ChatHistoryItemWithMessageId) =>
          entry.message.role === "assistant" &&
          entry.message.content === "This is a test",
      ),
    ).toBe(true);
    const compileCalls = request.mock.calls.filter(
      ([messageType]) => messageType === "llm/compileChat",
    );
    expect(compileCalls).toHaveLength(2);
    expect(JSON.stringify((compileCalls[0][1] as any).messages)).toContain(
      "original answer with substantial context",
    );
    // The second edit must retain the completed first edited turn. The broken
    // path synchronously rebuilt `firstTurnItems` from `new user + empty
    // assistant`, so this compile contained almost no context and its metric
    // remained near zero.
    expect(JSON.stringify((compileCalls[1][1] as any).messages)).toContain(
      "This is a test",
    );
  });

  it("hydrates a trimmed historical identity before resend", async () => {
    const store = makeStore({ truncated: true, loadedOffset: 2 });
    store.mockIdeMessenger.responses["history/load"] = {
      history: [
        item("h1", "user", "historical question"),
        item("h2", "assistant", "historical answer"),
        item("u1", "user", "earlier"),
        item("a1", "assistant", "sure"),
      ],
    } as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    expect(
      await run(
        store,
        submitSessionInput({
          sessionId: "s1",
          editorState: EDITOR_STATE,
          modifiers: MODIFIERS,
          targetMessageId: "h1",
        }),
      ),
    ).toBe(true);

    expect(request).toHaveBeenCalledWith("history/load", { id: "s1" });
    const target = session(store);
    expect(target.history).toHaveLength(2);
    expect(target.history[0].message.role).toBe("user");
    expect(target.history[0].message.id).not.toBe("h1");
    expect(target.history[1].message.role).toBe("assistant");
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

describe("submitSessionInput — measurement intent (Stage 2D 收口)", () => {
  it("does not carry a measurement for USER_SUBMITTED", async () => {
    // 方案.md §五.16.4: the immediate save holds the user message plus an EMPTY
    // assistant placeholder — not an authoritative full-conversation state. It must
    // keep the last-known metrics (stale) and let the terminal save form the new one.
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
    const payload = request.mock.calls.find(
      ([type]) => type === "history/save",
    )![1] as any;
    expect(payload.fullConversationMeasurement).toBeUndefined();
  });
});

describe("submitSessionInput — revision ownership (Stage 2F)", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  it("advances the content version exactly once for the submitted turn", async () => {
    const store = makeStore();
    const stream = deferredStream(store);
    const before = session(store).conversationRevision;

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    await stream.started();

    // One atomic write: the complete user item and the placeholder are both there,
    // and the content version moved exactly once.
    const target = session(store);
    expect(target.conversationRevision).toBe(before + 1);
    expect(target.history).toHaveLength(4);
    const userItem = target.history.at(-2);
    const placeholder = target.history.at(-1);
    expect(userItem.message.role).toBe("user");
    expect(textOf(userItem.message.content)).toContain("hello world");
    expect(userItem.contextItems).toEqual([]);
    expect(typeof userItem.message.id).toBe("string");
    expect(placeholder.message.role).toBe("assistant");
    expect(placeholder.message.content).toBe("");
    expect(placeholder.message.id).not.toBe(userItem.message.id);
    // The snapshot's value survives; its freshness identity is dropped.
    expect(target.fullConversationMetricsMeta).toBeUndefined();

    stream.release();
    await pending;

    // …and the reply's terminal commit is the second and last boundary.
    expect(session(store).conversationRevision).toBe(before + 2);
  });

  it("never exposes a placeholder next to an incomplete user message", async () => {
    // The old two-step write (structure, then content) had an observable window in
    // which history ended with an empty user message + placeholder. Any save
    // (unload flush, targeted mode/model save) could have persisted that window, and
    // a measurement would have described a conversation that never existed.
    const store = makeStore();
    const observed: ChatHistoryItemWithMessageId[][] = [];
    const unsubscribe = store.subscribe(() => {
      const history = (store.getState() as any).sessions.sessionsById.s1
        ?.history as ChatHistoryItemWithMessageId[] | undefined;
      if (history) {
        observed.push(history);
      }
    });

    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    unsubscribe();

    const incomplete = observed.filter((history) => {
      const last = history.at(-1);
      const previous = history.at(-2);
      return (
        last?.message.role === "assistant" &&
        last.message.content === "" &&
        (previous?.message.role !== "user" ||
          textOf(previous.message.content) === "")
      );
    });
    expect(incomplete).toEqual([]);
    expect(observed.length).toBeGreaterThan(0);
  });

  it("keeps one complete turn at exactly two versions when the turn fails before a token", async () => {
    const store = makeStore();
    store.mockIdeMessenger.llmStreamChat = async function* () {
      throw new Error("provider failed before the first token");
    } as any;
    const before = session(store).conversationRevision;

    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );

    // The submit is a content version; a failed terminal with no output is not.
    expect(session(store).conversationRevision).toBe(before + 1);
    const placeholder = session(store).history.at(-1);
    expect(placeholder.message.role).toBe("assistant");
    expect(placeholder.message.content).toBe("");
  });

  it("counts a partial-then-failed turn as two versions", async () => {
    const store = makeStore();
    store.mockIdeMessenger.llmStreamChat = async function* () {
      yield [{ role: "assistant", content: "half a" } as any];
      // A permanent failure: a transient one would open the retry dialog and the
      // thunk would wait for a choice that no test makes.
      throw new Error("provider failed after the first token");
    } as any;
    const before = session(store).conversationRevision;

    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );

    expect(session(store).conversationRevision).toBe(before + 2);
    expect(textOf(session(store).history.at(-1)?.message.content)).toContain(
      "half a",
    );
  });

  it("is one version for an edit-and-resend in the middle of the history", async () => {
    const store = makeStore({
      history: [
        item("u1", "user", "first"),
        item("a1", "assistant", "answer"),
        item("u2", "user", "second"),
        item("a2", "assistant", "answer 2"),
      ],
    });
    const stream = deferredStream(store);
    const before = session(store).conversationRevision;

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        index: 2,
      }),
    );
    await stream.started();

    const target = session(store);
    expect(target.conversationRevision).toBe(before + 1);
    expect(target.history).toHaveLength(4);
    expect(target.history[0].message.content).toBe("first");
    expect(target.history[1].message.content).toBe("answer");
    expect(textOf(target.history[2].message.content)).toContain("hello world");
    expect(target.history[3].message.content).toBe("");

    stream.release();
    await pending;
    expect(session(store).conversationRevision).toBe(before + 2);
  });

  it("re-points a surviving compaction summary without a second version", async () => {
    const store = makeStore({
      history: [
        item("u1", "user", "first"),
        { ...item("a1", "assistant", "answer"), conversationSummary: "s0" },
        item("u2", "user", "second"),
        item("a2", "assistant", "answer 2"),
      ],
      latestConversationSummary: {
        sourceMessageId: "a1",
        sourceAbsoluteIndex: 1,
        content: "s0",
      },
    });
    // The disk holds the same summary, so the save response's authority agrees with
    // the runtime value (otherwise clearing it would be a separate, legitimate
    // boundary that has nothing to do with the submitted turn).
    store.mockIdeMessenger.responses["history/save"] = {
      firstTurnItems: [],
      totalHistoryCount: 4,
      latestConversationSummary: {
        sourceMessageId: "a1",
        sourceAbsoluteIndex: 1,
        content: "s0",
      },
    } as any;
    const stream = deferredStream(store);
    const before = session(store).conversationRevision;

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        index: 2,
      }),
    );
    await stream.started();

    const target = session(store);
    expect(target.conversationRevision).toBe(before + 1);
    expect(target.latestConversationSummary).toEqual({
      sourceMessageId: "a1",
      sourceAbsoluteIndex: 1,
      content: "s0",
    });

    stream.release();
    await pending;
    expect(session(store).conversationRevision).toBe(before + 2);
    expect(session(store).latestConversationSummary).toEqual({
      sourceMessageId: "a1",
      sourceAbsoluteIndex: 1,
      content: "s0",
    });
  });

  it("drops a summary whose carrier the resend truncated, still as one version", async () => {
    const store = makeStore({
      history: [
        item("u1", "user", "first"),
        { ...item("a1", "assistant", "answer"), conversationSummary: "s0" },
        item("u2", "user", "second"),
        item("a2", "assistant", "answer 2"),
      ],
      latestConversationSummary: {
        sourceMessageId: "a1",
        sourceAbsoluteIndex: 1,
        content: "s0",
      },
    });
    const stream = deferredStream(store);
    const before = session(store).conversationRevision;

    // Replacing the carrier's own turn truncates it away.
    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        index: 1,
      }),
    );
    await stream.started();

    const target = session(store);
    expect(target.conversationRevision).toBe(before + 1);
    expect(target.latestConversationSummary).toBeUndefined();

    stream.release();
    await pending;
    expect(session(store).conversationRevision).toBe(before + 2);
  });

  it("enqueues USER_SUBMITTED only after the complete user content is written", async () => {
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
    const firstSave = request.mock.calls.find(
      ([type]) => type === "history/save",
    )![1] as any;
    // No measurement on this boundary (§五.16.4): the turn's authoritative metrics
    // come from the terminal save.
    expect(firstSave.fullConversationMeasurement).toBeUndefined();
    // …and the payload already carries the complete user message.
    const lastUser = [...firstSave.history]
      .reverse()
      .find((entry: any) => entry.message.role === "user");
    expect(textOf(lastUser.message.content)).toContain("hello world");
  });
});

describe("submitSessionInput — stale target across the async content resolution (Stage 2F 收口)", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  function submit(store: ReturnType<typeof makeStore>, extra: any = {}) {
    return run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        ...extra,
      }),
    );
  }

  function saveCalls(store: ReturnType<typeof makeStore>) {
    const spy = vi.spyOn(store.mockIdeMessenger, "request");
    return spy.mock.calls.filter(([type]: any[]) => type === "history/save");
  }

  it("appends at the tail the window has now, without truncating it", async () => {
    const store = makeStore();
    const gate = pauseAfterContentResolution();

    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const pending = submit(store);
    await gate.reached();
    // A hydration fills the window while the editor content is being resolved; it is
    // not a content version, so nothing else stops the submit.
    store.dispatch(
      setSessionHistory({
        sessionId: "s1",
        history: [
          item("x1", "user", "old head"),
          item("x2", "assistant", "old head answer"),
          item("u1", "user", "earlier"),
          item("a1", "assistant", "sure"),
        ],
        origin: "hydration",
      }),
    );
    gate.release();
    await pending;

    // The submitted turn lands after everything that was already there: a stale
    // `inputIndex` would have been read as "replace at 2" and dropped u1/a1.
    const ids = session(store).history.map((entry: any) => entry.message.id);
    expect(ids.slice(0, 4)).toEqual(["x1", "x2", "u1", "a1"]);
    expect(ids).toHaveLength(6);
    expect(session(store).history.at(-1).message.role).toBe("assistant");
  });

  it("replaces the target it was asked for, even after the window shifted", async () => {
    const store = makeStore({
      history: [
        item("u1", "user", "first"),
        item("a1", "assistant", "answer"),
        item("u2", "user", "second"),
        item("a2", "assistant", "answer 2"),
      ],
    });
    const gate = pauseAfterContentResolution();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const pending = submit(store, { targetMessageId: "u2" });
    await gate.reached();
    store.dispatch(
      setSessionHistory({
        sessionId: "s1",
        history: [
          item("x1", "user", "head"),
          item("x2", "assistant", "head answer"),
          ...session(store).history,
        ],
        origin: "hydration",
      }),
    );
    gate.release();
    await pending;

    const ids = session(store).history.map((entry: any) => entry.message.id);
    expect(ids.slice(0, 4)).toEqual(["x1", "x2", "u1", "a1"]);
    expect(ids).toHaveLength(6);
  });

  it("cancels the whole submit when the target identity is gone", async () => {
    const store = makeStore({
      history: [
        item("u1", "user", "first"),
        item("a1", "assistant", "answer"),
        item("u2", "user", "second"),
        item("a2", "assistant", "answer 2"),
      ],
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const gate = pauseAfterContentResolution();

    const pending = submit(store, { targetMessageId: "u2" });
    await gate.reached();
    // The target disappears without a content-version change (a hydration that no
    // longer contains it): only the identity check can catch this one.
    store.dispatch(
      setSessionHistory({
        sessionId: "s1",
        history: [
          item("u1", "user", "first"),
          item("a1", "assistant", "answer"),
        ],
        origin: "hydration",
      }),
    );
    gate.release();
    await expect(pending).resolves.toBe(false);

    // No commit, no save, no request: a stale submit must not rewrite another turn,
    // and it must not silently degrade into an append.
    expect(
      session(store).history.map((entry: any) => entry.message.id),
    ).toEqual(["u1", "a1"]);
    expect(saveCalls(store)).toHaveLength(0);
    expect(request).not.toHaveBeenCalledWith(
      "llm/streamChat",
      expect.anything(),
    );
  });

  it("cancels when the content moved on during resolution", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const gate = pauseAfterContentResolution();
    const pending = submit(store);
    await gate.reached();
    // A real content mutation (deleting a turn) — this is a new content version, so the
    // submit that was prepared against the old one must not land on top of it.
    store.dispatch(
      updateHistoryItemByMessageId({
        sessionId: "s1",
        messageId: "a1",
        updates: {
          message: { id: "a1", role: "assistant", content: "edited" },
        },
      }),
    );
    gate.release();

    // The wrapper turns the refusal into a reported failure (dialog), never a silent
    // send: `false` is the established contract for "this send did not happen".
    await expect(pending).resolves.toBe(false);
    expect(session(store).history).toHaveLength(2);
    expect(session(store).history.at(-1).message.content).toBe("edited");
    expect((store.getState() as any).ui.showDialog).toBe(true);
    expect(saveCalls(store)).toHaveLength(0);
  });

  it("cancels when the session is closed during resolution", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const gate = pauseAfterContentResolution();

    const pending = submit(store);
    await gate.reached();
    store.dispatch(removeSessionRuntime({ sessionId: "s1" }));
    gate.release();
    await expect(pending).resolves.toBe(false);

    expect(saveCalls(store)).toHaveLength(0);
  });

  it("clears the submit-side runtime only after a commit that happened", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const gate = pauseAfterContentResolution();
    // What the editor layer stores when a previous send failed and the user must get
    // the attachments back.
    store.dispatch(
      setSessionMainEditorAttachmentsRestore({
        sessionId: "s1",
        attachments: [{ name: "a.ts", path: "file:///a.ts", content: "x" }],
      }),
    );

    const pending = submit(store);
    await gate.reached();
    store.dispatch(removeSessionRuntime({ sessionId: "s1" }));
    gate.release();
    await expect(pending).resolves.toBe(false);

    // The runtime is gone, so the restore state cannot be observed on it; what matters
    // is that the cancel path dispatched neither a save nor a stream request.
    expect(saveCalls(store)).toHaveLength(0);
    expect(request).not.toHaveBeenCalledWith(
      "llm/streamChat",
      expect.anything(),
    );
  });
});
