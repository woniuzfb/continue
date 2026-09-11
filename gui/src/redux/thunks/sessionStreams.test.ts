import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelDescription, Tool } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { beginSessionStream } from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import {
  checkpointSessionStream,
  resetSessionStreamCheckpoints,
  runSessionStream,
  stopSessionStream,
} from "./sessionStreams";
import { resetSessionStreamRunner } from "./sessionTools";

const CHAT_MODEL = {
  title: "gpt-4o",
  provider: "openai",
  model: "gpt-4o",
  underlyingProviderName: "openai",
} as ModelDescription;

const TOOL: Tool = {
  type: "function",
  function: { name: "run_terminal_cmd", description: "run a command" },
  displayTitle: "Run command",
  wouldLikeTo: "run a command",
  readonly: false,
  group: "built-in",
};

function user(id: string, content = "hi"): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role: "user",
      content,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

type StoreOptions = {
  mode?: "chat" | "agent";
  toolPolicies?: Record<string, string>;
  stream?: { status: "idle" | "streaming"; requestId?: string };
  chatModelTitle?: string;
  models?: ModelDescription[];
  title?: string;
  truncated?: boolean;
  loadedOffset?: number;
  firstTurnItems?: ChatHistoryItemWithMessageId[];
  persistence?: any;
  contextMetrics?: any;
  contextMetricsMeta?: any;
  history?: ChatHistoryItemWithMessageId[];
};

function makeStore(options: StoreOptions = {}) {
  const {
    mode = "agent",
    toolPolicies = {},
    stream = { status: "idle" },
    chatModelTitle = "gpt-4o",
    models = [CHAT_MODEL],
    title = "Chat 1",
    truncated = false,
    loadedOffset = 0,
    firstTurnItems,
    persistence,
    contextMetrics,
    contextMetricsMeta,
    history = [user("u1")],
  } = options;

  const s1 = initialSessionRuntime("s1", title, {
    history,
    mode,
    chatModelTitle,
    stream: stream as any,
    ...(firstTurnItems ? { firstTurnItems } : {}),
    ...(persistence ? { persistence } : {}),
    ...(contextMetrics ? { contextMetrics } : {}),
    ...(contextMetricsMeta ? { contextMetricsMeta } : {}),
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
    history: [user("u2")],
    mode: "agent",
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
        tools: [TOOL],
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat: models,
        },
      },
    },
    ui: {
      ...(createMockStore().getState() as any).ui,
      toolSettings: toolPolicies,
    },
  });
}

function session(store: ReturnType<typeof makeStore>, sessionId = "s1") {
  return (store.getState() as any).sessions.sessionsById[sessionId];
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

function toolCallChunk(toolCallId = "t1"): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: toolCallId,
        type: "function",
        function: {
          name: "run_terminal_cmd",
          arguments: '{"command":"ls"}',
        },
      },
    ],
  } as any;
}

function textChunk(text: string): ChatMessage {
  return { role: "assistant", content: text } as ChatMessage;
}

describe("sessionStreams", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  it("streams a reply into the target session and finishes completed", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));

    const target = session(store);
    const lastMessage = target.history.at(-1).message;
    expect(lastMessage.role).toBe("assistant");
    expect(lastMessage.content).toBe("This is a test");
    expect(target.stream).toEqual({ status: "idle" });
    // Terminal commit: the reply is final, so the snapshot is stale — its
    // freshness identity is cleared while the last-known value stays visible.
    expect(target.contextMetricsMeta).toBeUndefined();
    expect(target.contextMetrics).toBeDefined();
    expect(request).toHaveBeenCalledWith("llm/compileChat", expect.anything());
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
    // The active tab is untouched.
    expect(session(store, "s2").history).toHaveLength(1);
  });

  it("does not overwrite the full-conversation metrics with a reduced Local Provider request", async () => {
    // 方案.md §五.16: a truncated Local Provider request sends only
    // firstTurnItems + currentTurnItems, so its compile result must never
    // replace the full-conversation snapshot.
    const localModel = {
      title: "local",
      provider: "continue-local",
      model: "LLM:local",
      underlyingProviderName: "continue-local",
    } as ModelDescription;
    const sentinel = {
      didPrune: false,
      contextPercentage: 0.99,
      inputTokens: 199149,
      contextLength: 200000,
    };
    const store = makeStore({
      models: [localModel],
      chatModelTitle: "local",
      truncated: true,
      loadedOffset: 10,
      firstTurnItems: [user("f1", "first turn question")],
      persistence: {
        state: "clean",
        revision: 0,
        persistedRevision: 0,
        hasPersistedBaseline: true,
      },
      contextMetrics: sentinel,
      contextMetricsMeta: {
        modelIdentity: "local",
        historyRevision: 0,
        schemaVersion: 1,
      },
    });

    await run(store, runSessionStream({ sessionId: "s1" }));

    // The reduced request did not overwrite the full-conversation snapshot,
    // and no bookkeeping update invalidated it either.
    expect(session(store).contextMetrics).toEqual(sentinel);
  });

  it("does not overwrite the metrics when a non-truncated Local Provider still reduces", async () => {
    // 方案.md §五.16: the fast path depends on firstTurnItems + a reliable
    // baseline, NOT on pagination.truncated. A non-truncated window with
    // middle turns still sends only firstTurn + currentTurn.
    const localModel = {
      title: "local",
      provider: "continue-local",
      model: "LLM:local",
      underlyingProviderName: "continue-local",
    } as ModelDescription;
    const sentinel = {
      didPrune: false,
      contextPercentage: 0.99,
      inputTokens: 199149,
      contextLength: 200000,
    };
    const store = makeStore({
      models: [localModel],
      chatModelTitle: "local",
      truncated: false,
      history: [
        user("u1", "first first"),
        user("u2", "middle middle"),
        user("u3", "current current"),
      ],
      firstTurnItems: [user("u1", "first first")],
      persistence: {
        state: "clean",
        revision: 0,
        persistedRevision: 0,
        hasPersistedBaseline: true,
      },
      contextMetrics: sentinel,
      contextMetricsMeta: {
        modelIdentity: "local",
        historyRevision: 0,
        schemaVersion: 1,
      },
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));

    const compile = request.mock.calls.find(
      ([messageType]) => messageType === "llm/compileChat",
    );
    const sent = JSON.stringify((compile![1] as any).messages);
    // The reduced request kept the first turn and the current turn, and dropped
    // the middle turn.
    expect(sent).toContain("first first");
    expect(sent).toContain("current current");
    expect(sent).not.toContain("middle middle");
    // ...so it must not have overwritten the full-conversation snapshot.
    expect(session(store).contextMetrics).toEqual(sentinel);
  });

  it("protects every message of a Local Provider request from pruning", async () => {
    const localModel = {
      title: "local",
      provider: "continue-local",
      model: "LLM:local",
      underlyingProviderName: "continue-local",
    } as ModelDescription;
    const store = makeStore({ models: [localModel], chatModelTitle: "local" });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));

    const compileCall = request.mock.calls.find(
      ([messageType]) => messageType === "llm/compileChat",
    );
    expect(compileCall).toBeDefined();
    const payload = compileCall![1] as any;
    // 方案.md §十四: system + first turn + current turn are all protected, so an
    // over-budget request must fail as out-of-context instead of being pruned.
    expect(payload.protectedMessageIndexes).toEqual(
      payload.messages.map((_: unknown, index: number) => index),
    );
  });

  it("does not protect messages for a normal provider", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));

    const compileCall = request.mock.calls.find(
      ([messageType]) => messageType === "llm/compileChat",
    );
    expect((compileCall![1] as any).protectedMessageIndexes).toBeUndefined();
  });

  it("ignores a continuation whose predecessor request is no longer live", async () => {
    const store = makeStore({
      stream: { status: "streaming", requestId: "req-2" },
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1", requestId: "req-1" }));

    expect(request).not.toHaveBeenCalled();
    expect(session(store).stream.requestId).toBe("req-2");
    expect(session(store).history).toHaveLength(1);
  });

  it("reports out-of-context as an inline error and stops the stream", async () => {
    const store = makeStore();
    store.mockIdeMessenger.request = vi.fn(async (type: string) => {
      if (type === "llm/compileChat") {
        return { status: "error", error: "Not enough context", done: true };
      }
      return { status: "success", content: undefined, done: true };
    }) as any;

    await run(store, runSessionStream({ sessionId: "s1" }));

    const target = session(store);
    expect(target.inlineErrorMessage).toBe("out-of-context");
    expect(target.stream).toEqual({ status: "failed" });
  });

  it("marks the stream failed when no model is selected", async () => {
    const store = makeStore({ chatModelTitle: undefined, models: [] });

    await run(store, runSessionStream({ sessionId: "s1" }));

    expect(session(store).stream.status).toBe("failed");
    expect(session(store).stream.error).toBe("No chat model selected");
  });

  it("keeps the request live while a tool call awaits approval", async () => {
    const store = makeStore();
    store.mockIdeMessenger.chatResponse = [toolCallChunk()];
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));

    const target = session(store);
    const toolCallState = target.history
      .flatMap((item: any) => item.toolCallStates ?? [])
      .at(0);
    expect(toolCallState).toMatchObject({
      toolCallId: "t1",
      status: "generated",
    });
    expect(target.pendingApprovalCount).toBe(1);
    // Awaiting approval is not a terminal state: the model is no longer
    // streaming, but the request stays live so the tool loop can continue.
    expect(target.stream.status).toBe("idle");
    expect(typeof target.stream.requestId).toBe("string");
    expect(request).not.toHaveBeenCalledWith("tools/call", expect.anything());
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
  });

  it("executes auto-approved calls and continues the turn", async () => {
    const store = makeStore({
      toolPolicies: { run_terminal_cmd: "allowedWithoutPermission" },
    });
    let turn = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      turn++;
      yield turn === 1 ? [toolCallChunk()] : [textChunk("done")];
    } as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));
    await vi.waitFor(() => {
      expect(session(store).stream).toEqual({ status: "idle" });
    });

    expect(request).toHaveBeenCalledWith("tools/call", expect.anything());
    const target = session(store);
    const toolCallState = target.history
      .flatMap((item: any) => item.toolCallStates ?? [])
      .at(0);
    expect(toolCallState?.status).toBe("done");
    expect(target.history.at(-1).message.content).toBe("done");
    expect(
      target.history.some(
        (item: any) =>
          item.message.role === "tool" && item.message.toolCallId === "t1",
      ),
    ).toBe(true);
    expect(target.pendingApprovalCount).toBe(0);
    expect(turn).toBe(2);
  });

  it("stops only the named live request", async () => {
    const store = makeStore({
      stream: { status: "streaming", requestId: "req-1" },
    });
    const aborter = new AbortController();
    store.dispatch(
      beginSessionStream({ sessionId: "s1", requestId: "req-1", aborter }),
    );

    expect(
      await run(
        store,
        stopSessionStream({ sessionId: "s1", requestId: "other" }),
      ),
    ).toBe(false);
    expect(aborter.signal.aborted).toBe(false);

    expect(
      await run(
        store,
        stopSessionStream({ sessionId: "s1", requestId: "req-1" }),
      ),
    ).toBe(true);
    expect(aborter.signal.aborted).toBe(true);
  });

  it("gates regular checkpoints but always saves forced boundaries", async () => {
    const store = makeStore({
      stream: { status: "streaming", requestId: "req-1" },
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const skipped = await run(
      store,
      checkpointSessionStream({
        sessionId: "s1",
        requestId: "req-1",
        reason: "regular",
      }),
    );
    expect(skipped).toBe(false);

    const forced = await run(
      store,
      checkpointSessionStream({
        sessionId: "s1",
        requestId: "req-1",
        reason: "TOOL_CALLS_GENERATED",
        force: true,
      }),
    );
    expect(forced).toBe(true);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
  });

  it("generates a title after the turn completes", async () => {
    const store = makeStore({ title: NEW_SESSION_TITLE });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));
    await vi.waitFor(() => {
      expect(session(store).title).toBe("Session summary");
    });

    expect(request).toHaveBeenCalledWith(
      "chatDescriber/describe",
      expect.anything(),
    );
  });

  it("ignores a checkpoint for a stale request", async () => {
    const store = makeStore({
      stream: { status: "streaming", requestId: "req-2" },
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    expect(
      await run(
        store,
        checkpointSessionStream({
          sessionId: "s1",
          requestId: "req-1",
          reason: "regular",
          force: true,
        }),
      ),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
