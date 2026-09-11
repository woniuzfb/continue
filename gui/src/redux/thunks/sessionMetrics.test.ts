import { describe, expect, it, vi } from "vitest";
import type { ModelDescription } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { ensureSessionContextMetrics } from "./sessionActivation";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  initialSessionRuntime,
  type SessionRuntimeState,
} from "../slices/sessionsSlice";
import {
  CONTEXT_METRICS_SCHEMA_VERSION,
  compileSessionChatForContextMetrics,
  needsContextMetricsRecompute,
} from "./sessionMetrics";

const CHAT_MODEL = {
  title: "gpt-4o",
  provider: "openai",
  model: "gpt-4o",
} as ModelDescription;

function item(
  id: string,
  role: "user" | "assistant",
  content = "hi",
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

const METRICS = {
  didPrune: false,
  contextPercentage: 0.5,
  inputTokens: 10,
  contextLength: 100,
};

function makeStore(overrides: Partial<SessionRuntimeState> = {}) {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [item("u1", "user"), item("a1", "assistant")],
    mode: "agent",
    chatModelTitle: "gpt-4o",
    historyRevision: 3,
    contextMetrics: METRICS,
    contextMetricsMeta: {
      modelIdentity: "gpt-4o",
      historyRevision: 3,
      schemaVersion: CONTEXT_METRICS_SCHEMA_VERSION,
    },
    ...overrides,
  });
  const s2 = initialSessionRuntime("s2", "Chat 2", {
    history: [item("u2", "user"), item("a2", "assistant")],
    mode: "agent",
    chatModelTitle: "gpt-4o",
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
          chat: [CHAT_MODEL],
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

describe("needsContextMetricsRecompute", () => {
  it("reuses a snapshot whose model, revision and schema all match", () => {
    const store = makeStore();
    expect(needsContextMetricsRecompute(store.getState() as any, "s1")).toBe(
      false,
    );
  });

  it("recomputes when the snapshot or its identity is missing", () => {
    const noSnapshot = makeStore({ contextMetrics: undefined });
    expect(
      needsContextMetricsRecompute(noSnapshot.getState() as any, "s1"),
    ).toBe(true);

    const noMeta = makeStore({ contextMetricsMeta: undefined });
    expect(needsContextMetricsRecompute(noMeta.getState() as any, "s1")).toBe(
      true,
    );
  });

  it("recomputes when the schema or the model changed", () => {
    const oldSchema = makeStore({
      contextMetricsMeta: {
        modelIdentity: "gpt-4o",
        historyRevision: 3,
        schemaVersion: CONTEXT_METRICS_SCHEMA_VERSION + 1,
      },
    });
    expect(
      needsContextMetricsRecompute(oldSchema.getState() as any, "s1"),
    ).toBe(true);

    const otherModel = makeStore({
      contextMetricsMeta: {
        modelIdentity: "gpt-3.5",
        historyRevision: 3,
        schemaVersion: CONTEXT_METRICS_SCHEMA_VERSION,
      },
    });
    expect(
      needsContextMetricsRecompute(otherModel.getState() as any, "s1"),
    ).toBe(true);
  });

  it("recomputes after any request-relevant history change", () => {
    const store = makeStore();

    store.dispatch({
      type: "sessions/updateHistoryItemByMessageId",
      payload: {
        sessionId: "s1",
        messageId: "a1",
        updates: { contextItems: [] },
      },
    });

    expect(session(store).historyRevision).toBe(4);
    expect(needsContextMetricsRecompute(store.getState() as any, "s1")).toBe(
      true,
    );
  });

  it("ignores an unknown session", () => {
    const store = makeStore();
    expect(needsContextMetricsRecompute(store.getState() as any, "nope")).toBe(
      false,
    );
  });
});

describe("compileSessionChatForContextMetrics", () => {
  it("stores the snapshot with its identity for the target session", async () => {
    const store = makeStore({
      contextMetrics: undefined,
      contextMetricsMeta: undefined,
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, compileSessionChatForContextMetrics({ sessionId: "s1" }));

    expect(request).toHaveBeenCalledWith("llm/compileChat", expect.anything());
    expect(session(store).contextMetrics).toMatchObject({
      didPrune: false,
      contextPercentage: 0.5,
    });
    expect(session(store).contextMetricsMeta).toEqual({
      modelIdentity: "gpt-4o",
      historyRevision: 3,
      schemaVersion: CONTEXT_METRICS_SCHEMA_VERSION,
    });
    // The active session is untouched.
    expect(session(store, "s2").contextMetrics).toBeUndefined();
  });

  it("rejects a metrics compile whose input was superseded", async () => {
    const store = makeStore();
    const metaBefore = session(store).contextMetricsMeta;
    const original = store.mockIdeMessenger.request.bind(
      store.mockIdeMessenger,
    );
    (store.mockIdeMessenger as any).request = vi.fn(
      async (type: string, data: any) => {
        if (type === "llm/compileChat") {
          // The history moves while the compile is in flight.
          store.dispatch({
            type: "sessions/setSessionHistory",
            payload: {
              sessionId: "s1",
              history: [
                item("u1", "user", "hi"),
                item("a1", "assistant", "sure"),
              ],
            },
          } as any);
        }
        return original(type as any, data as any);
      },
    );

    await run(store, compileSessionChatForContextMetrics({ sessionId: "s1" }));

    // The stale result was not labelled with the newer revision.
    expect(session(store).contextMetricsMeta).toBe(metaBefore);
  });

  it("keeps the last-known value when the compile cannot fit the conversation", async () => {
    const store = makeStore();
    const metaBefore = session(store).contextMetricsMeta;
    const valueBefore = session(store).contextMetrics;
    (store.mockIdeMessenger as any).request = vi.fn(async (type: string) => {
      if (type === "llm/compileChat") {
        return {
          status: "error",
          error:
            "Not enough context available to include all protected messages",
          done: true,
        };
      }
      return { status: "success", content: {}, done: true };
    });

    await run(store, compileSessionChatForContextMetrics({ sessionId: "s1" }));

    expect(session(store).contextMetrics).toBe(valueBefore);
    expect(session(store).contextMetricsMeta).toBe(metaBefore);
  });

  it("is a no-op without a model or an empty history", async () => {
    const noModel = makeStore({ chatModelTitle: undefined });
    (noModel.getState() as any).config.config.modelsByRole.chat = [];
    const request = vi.spyOn(noModel.mockIdeMessenger, "request");
    await run(
      noModel,
      compileSessionChatForContextMetrics({ sessionId: "s1" }),
    );
    expect(request).not.toHaveBeenCalled();

    const empty = makeStore({ history: [] });
    await run(empty, compileSessionChatForContextMetrics({ sessionId: "s1" }));
  });
});

describe("ensureSessionContextMetrics", () => {
  it("skips the compile while the snapshot is valid", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, ensureSessionContextMetrics({ sessionId: "s1" }));

    expect(request).not.toHaveBeenCalledWith(
      "llm/compileChat",
      expect.anything(),
    );
  });

  it("uses the same completion options as the real send", async () => {
    const store = makeStore({ historyRevision: 9, hasReasoningEnabled: true });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, ensureSessionContextMetrics({ sessionId: "s1" }));

    const compileCall = request.mock.calls.find(
      ([messageType]) => messageType === "llm/compileChat",
    );
    expect(compileCall).toBeDefined();
    // The session's reasoning preference must reach the metrics compile,
    // otherwise the reported context percentage describes another request.
    expect((compileCall![1] as any).options).toMatchObject({
      reasoning: true,
    });
  });

  it("compiles a background session when its snapshot is stale", async () => {
    const store = makeStore({ historyRevision: 9 });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, ensureSessionContextMetrics({ sessionId: "s1" }));

    expect(request).toHaveBeenCalledWith("llm/compileChat", expect.anything());
    expect(session(store).contextMetricsMeta?.historyRevision).toBe(9);
  });
});
