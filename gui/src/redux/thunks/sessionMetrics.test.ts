import { describe, expect, it, vi } from "vitest";
import type { ModelDescription } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { ensureFullConversationMetrics } from "./sessionActivation";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  initialSessionRuntime,
  type SessionRuntimeState,
} from "../slices/sessionsSlice";
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  compileFullConversationForMetrics,
  needsFullConversationMetricsRecompute,
  sessionConstructionIdentity,
} from "./sessionMetrics";
import {
  setSessionFullConversationMetrics,
  setSessionMode,
} from "../slices/sessionsSlice";

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
  inputTokens: 10,
  contextLength: 100,
  availableTokens: 90,
  contextPercentage: 0.5,
  exceedsContext: false,
};

/**
 * A snapshot is only valid together with its **complete** identity, so the
 * fixture seeds it the way production does: through the reducer, with the
 * identity computed from this session's own resolved inputs.
 */
function makeStore(
  overrides: Partial<SessionRuntimeState> = {},
  seed: { identity?: string; withMeta?: boolean } | false = {},
) {
  if (seed !== false && seed.withMeta === false) {
    // Value without a freshness identity: what a disk restore or a content
    // change leaves behind (方案.md §五.16.5 ⇒ stale).
    return createStore({ ...overrides, fullConversationMetrics: METRICS });
  }
  const store = createStore(overrides);
  if (seed === false) {
    return store;
  }
  store.dispatch(
    setSessionFullConversationMetrics({
      sessionId: "s1",
      result: {
        metrics: METRICS,
        meta: {
          conversationRevision: session(store).conversationRevision,
          constructionIdentity:
            seed.identity ??
            sessionConstructionIdentity(store.getState() as any, "s1") ??
            "",
          schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
        },
      },
    }),
  );
  return store;
}

function createStore(overrides: Partial<SessionRuntimeState> = {}) {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [item("u1", "user"), item("a1", "assistant")],
    mode: "agent",
    chatModelTitle: "gpt-4o",
    conversationRevision: 3,
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

describe("needsFullConversationMetricsRecompute", () => {
  it("reuses a snapshot whose model, revision and schema all match", () => {
    const store = makeStore();
    expect(
      needsFullConversationMetricsRecompute(store.getState() as any, "s1"),
    ).toBe(false);
  });

  it("recomputes when the snapshot or its identity is missing", () => {
    const noSnapshot = makeStore({}, false);
    expect(
      needsFullConversationMetricsRecompute(noSnapshot.getState() as any, "s1"),
    ).toBe(true);

    const noMeta = makeStore({}, { withMeta: false });
    expect(
      needsFullConversationMetricsRecompute(noMeta.getState() as any, "s1"),
    ).toBe(true);
  });

  it("recomputes when the schema or the construction identity changed", () => {
    // An identity from another construction environment (other model, other
    // rules, other tools) describes another prompt: never reusable.
    const otherConstruction = makeStore({}, { identity: "gpt-3.5" });
    expect(
      needsFullConversationMetricsRecompute(
        otherConstruction.getState() as any,
        "s1",
      ),
    ).toBe(true);

    const oldSchema = makeStore();
    oldSchema.dispatch(
      setSessionFullConversationMetrics({
        sessionId: "s1",
        result: {
          metrics: METRICS,
          meta: {
            conversationRevision: 3,
            constructionIdentity: sessionConstructionIdentity(
              oldSchema.getState() as any,
              "s1",
            )!,
            schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION + 1,
          },
        },
      }),
    );
    expect(
      needsFullConversationMetricsRecompute(oldSchema.getState() as any, "s1"),
    ).toBe(true);
  });

  it("recomputes when only the construction environment moved", () => {
    // 方案.md §五.16.1: mode is not a content version — it must not advance the
    // conversation revision, but it must still invalidate the snapshot.
    const store = makeStore();
    const revisionBefore = session(store).conversationRevision;

    store.dispatch(setSessionMode({ sessionId: "s1", mode: "chat" }));

    expect(session(store).conversationRevision).toBe(revisionBefore);
    expect(
      needsFullConversationMetricsRecompute(store.getState() as any, "s1"),
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

    expect(session(store).conversationRevision).toBe(4);
    expect(
      needsFullConversationMetricsRecompute(store.getState() as any, "s1"),
    ).toBe(true);
  });

  it("ignores an unknown session", () => {
    const store = makeStore();
    expect(
      needsFullConversationMetricsRecompute(store.getState() as any, "nope"),
    ).toBe(false);
  });
});

describe("compileFullConversationForMetrics", () => {
  it("stores the snapshot with its identity for the target session", async () => {
    const store = makeStore({}, false);
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, compileFullConversationForMetrics({ sessionId: "s1" }));

    expect(request).toHaveBeenCalledWith("llm/compileChat", expect.anything());
    expect(session(store).fullConversationMetrics).toMatchObject({
      exceedsContext: false,
      contextPercentage: 0.5,
    });
    expect(session(store).fullConversationMetricsMeta).toEqual({
      constructionIdentity: sessionConstructionIdentity(
        store.getState() as any,
        "s1",
      ),
      conversationRevision: 3,
      schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
    });
    // The active session is untouched.
    expect(session(store, "s2").fullConversationMetrics).toBeUndefined();
  });

  it("rejects a metrics compile whose input was superseded", async () => {
    const store = makeStore();
    const valueBefore = session(store).fullConversationMetrics;
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
              origin: "content",
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

    await run(store, compileFullConversationForMetrics({ sessionId: "s1" }));

    // The stale result was not written: the snapshot is still the last-known
    // value and carries no freshness identity after the content change.
    expect(session(store).fullConversationMetrics).toBe(valueBefore);
    expect(session(store).fullConversationMetricsMeta).toBeUndefined();
  });

  it("keeps the last-known value when the compile cannot fit the conversation", async () => {
    const store = makeStore();
    const metaBefore = session(store).fullConversationMetricsMeta;
    const valueBefore = session(store).fullConversationMetrics;
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

    await run(store, compileFullConversationForMetrics({ sessionId: "s1" }));

    expect(session(store).fullConversationMetrics).toBe(valueBefore);
    expect(session(store).fullConversationMetricsMeta).toBe(metaBefore);
  });

  it("is a no-op without a model or an empty history", async () => {
    const noModel = makeStore({ chatModelTitle: undefined });
    (noModel.getState() as any).config.config.modelsByRole.chat = [];
    const request = vi.spyOn(noModel.mockIdeMessenger, "request");
    await run(noModel, compileFullConversationForMetrics({ sessionId: "s1" }));
    expect(request).not.toHaveBeenCalled();

    const empty = makeStore({ history: [] });
    await run(empty, compileFullConversationForMetrics({ sessionId: "s1" }));
  });
});

describe("ensureFullConversationMetrics", () => {
  it("skips the compile while the snapshot is valid", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, ensureFullConversationMetrics({ sessionId: "s1" }));

    expect(request).not.toHaveBeenCalledWith(
      "llm/compileChat",
      expect.anything(),
    );
  });

  it("uses the same completion options as the real send", async () => {
    const store = makeStore(
      { conversationRevision: 9, hasReasoningEnabled: true },
      false,
    );
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, ensureFullConversationMetrics({ sessionId: "s1" }));

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
    const store = makeStore({ conversationRevision: 9 }, false);
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, ensureFullConversationMetrics({ sessionId: "s1" }));

    expect(request).toHaveBeenCalledWith("llm/compileChat", expect.anything());
    expect(
      session(store).fullConversationMetricsMeta?.conversationRevision,
    ).toBe(9);
  });
});
