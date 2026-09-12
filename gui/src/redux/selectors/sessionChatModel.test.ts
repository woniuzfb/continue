import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { selectSessionChatModel, sessionChatModelRefOf } from "./sessions";
import { setSessionChatModelAndSave } from "../thunks/sessionChanges";

/**
 * 方案.md §7.5.1: a session's model choice must not silently become another model.
 *
 * Reported: the toolbar showed the session's model while the request was sent with a different
 * one. The reachable cause is this fallback — a session with its own `chatModelTitle` whose entry
 * is momentarily missing from the compiled list used to resolve to the profile default, so the
 * send continued with B while the UI still described A.
 */

const MODEL_A = { title: "model-a", provider: "openai", model: "a" };
const MODEL_B = { title: "model-b", provider: "openai", model: "b" };

function storeWith(
  models: any[],
  chatModelTitle: string | undefined,
  defaultModel: any,
) {
  const runtime = initialSessionRuntime("A", "A");
  if (chatModelTitle !== undefined) {
    runtime.chatModelTitle = chatModelTitle;
  }
  const store = createMockStore({
    sessions: {
      activeSessionId: "A",
      tabOrder: ["A"],
      tabDescriptors: {
        A: { sessionId: "A", title: "A", loadState: "loaded" },
      },
      sessionsById: { A: runtime },
    },
  });
  const config = (store.getState() as any).config.config;
  store.dispatch({
    type: "config/updateConfig",
    payload: {
      ...config,
      modelsByRole: { ...config.modelsByRole, chat: models },
      selectedModelByRole: {
        ...config.selectedModelByRole,
        chat: defaultModel,
      },
    },
  });
  return store;
}

describe("selectSessionChatModel", () => {
  it("resolves the session's own choice", () => {
    const store = storeWith([MODEL_A, MODEL_B], "model-a", MODEL_B);
    expect(selectSessionChatModel(store.getState() as any, "A")?.title).toBe(
      "model-a",
    );
  });

  it("uses the profile default only when the session has no choice of its own", () => {
    const store = storeWith([MODEL_A, MODEL_B], undefined, MODEL_B);
    expect(selectSessionChatModel(store.getState() as any, "A")?.title).toBe(
      "model-b",
    );
  });

  it("returns nothing when the session's own choice cannot be resolved — never another model", () => {
    // model-a is gone from the compiled list (config reload / renamed entry / provider removed).
    const store = storeWith([MODEL_B], "model-a", MODEL_B);
    expect(
      selectSessionChatModel(store.getState() as any, "A"),
    ).toBeUndefined();
  });

  it("treats a duplicated title as unresolvable rather than guessing", () => {
    const otherProviderA = {
      title: "model-a",
      provider: "anthropic",
      model: "a",
    };
    const store = storeWith([MODEL_A, otherProviderA], "model-a", MODEL_B);
    expect(
      selectSessionChatModel(store.getState() as any, "A"),
    ).toBeUndefined();
  });
});

describe("stable identity (方案.md §7.5.4)", () => {
  it("resolves by the session's stable id ref, not by title alone", () => {
    // Two entries share the title; only the ref distinguishes them.
    const anthropicA = { title: "model-a", provider: "anthropic", model: "a" };
    const store = storeWith([MODEL_A, anthropicA], undefined, MODEL_B);
    store.dispatch({
      type: "sessions/setSessionChatModelTitle",
      payload: {
        sessionId: "A",
        chatModelTitle: "model-a",
        chatModelRef: { title: "model-a", provider: "anthropic", model: "a" },
      },
    });
    // Immer replaces the session object, so re-read it after the dispatch.
    expect(
      (store.getState() as any).sessions.sessionsById.A.chatModelRef.provider,
    ).toBe("anthropic");
    expect(selectSessionChatModel(store.getState() as any, "A")?.provider).toBe(
      "anthropic",
    );
  });

  it("refuses when the ref no longer matches exactly one entry", () => {
    const store = storeWith([MODEL_B], undefined, MODEL_B);
    store.dispatch({
      type: "sessions/setSessionChatModelTitle",
      payload: {
        sessionId: "A",
        chatModelTitle: "model-a",
        chatModelRef: { title: "model-a", provider: "openai", model: "a" },
      },
    });
    expect(
      selectSessionChatModel(store.getState() as any, "A"),
    ).toBeUndefined();
  });

  it("keeps the turn-captured identity when the model is switched mid-turn", () => {
    // The snapshot lives on the stream state and is inherited by continuations.
    const session = initialSessionRuntime("A", "A");
    session.chatModelRef = { title: "model-a", provider: "openai", model: "a" };
    const store = createMockStore({
      sessions: {
        activeSessionId: "A",
        tabOrder: ["A"],
        tabDescriptors: {
          A: { sessionId: "A", title: "A", loadState: "loaded" },
        },
        sessionsById: { A: session },
      },
    });
    store.dispatch({
      type: "sessions/beginSessionStream",
      payload: {
        sessionId: "A",
        requestId: "r1",
        chatModelRef: session.chatModelRef,
      },
    });
    store.dispatch({
      type: "sessions/setSessionChatModelTitle",
      payload: {
        sessionId: "A",
        chatModelTitle: "model-b",
        chatModelRef: { title: "model-b", provider: "openai", model: "b" },
      },
    });
    // A continuation (new requestId, no explicit ref) keeps the turn's model.
    store.dispatch({
      type: "sessions/beginSessionStream",
      payload: { sessionId: "A", requestId: "r2" },
    });
    expect(
      (store.getState() as any).sessions.sessionsById.A.stream.chatModelRef
        .title,
    ).toBe("model-a");
    // …while the session's own choice is the new one.
    expect(
      (store.getState() as any).sessions.sessionsById.A.chatModelTitle,
    ).toBe("model-b");
  });
});

describe("fresh turn captures the resolved identity (方案.md §7.5.3)", () => {
  /** The ref a fresh turn would snapshot: resolved model → identity, or nothing. */
  const turnRefOf = (state: any, sessionId: string) =>
    sessionChatModelRefOf(selectSessionChatModel(state, sessionId));

  it("captures a legacy title-only session's resolved model", () => {
    const store = storeWith([MODEL_A, MODEL_B], "model-a", MODEL_B);
    expect(turnRefOf(store.getState(), "A")).toEqual({
      title: "model-a",
      provider: "openai",
      model: "a",
    });
  });

  it("captures the profile default for a session that has no choice yet", () => {
    const store = storeWith([MODEL_A, MODEL_B], undefined, MODEL_B);
    expect(turnRefOf(store.getState(), "A")).toEqual({
      title: "model-b",
      provider: "openai",
      model: "b",
    });
  });

  it("captures nothing when the session's choice cannot be resolved", () => {
    // The stream then fails through the existing "no chat model" path: no compile, no llmStreamChat.
    const store = storeWith([MODEL_B], "model-a", MODEL_B);
    expect(turnRefOf(store.getState(), "A")).toBeUndefined();
  });
});

describe("choosing a model identifies it by ref, not by title (方案.md §7.5.4)", () => {
  it("stores the clicked entry even when another shares its title", async () => {
    const anthropicA = { title: "model-a", provider: "anthropic", model: "a" };
    const store = storeWith([MODEL_A, anthropicA], undefined, MODEL_A);
    await store.dispatch(
      setSessionChatModelAndSave({
        sessionId: "A",
        chatModelRef: { title: "model-a", provider: "anthropic", model: "a" },
      }) as any,
    );
    expect(
      (store.getState() as any).sessions.sessionsById.A.chatModelRef,
    ).toEqual({ title: "model-a", provider: "anthropic", model: "a" });
  });

  it("keeps the current choice when the selection cannot be resolved", async () => {
    const store = storeWith([MODEL_A, MODEL_B], "model-a", MODEL_B);
    await store.dispatch(
      setSessionChatModelAndSave({
        sessionId: "A",
        chatModelRef: { title: "gone", provider: "openai", model: "gone" },
      }) as any,
    );
    const session = (store.getState() as any).sessions.sessionsById.A;
    expect(session.chatModelTitle).toBe("model-a");
    expect(session.chatModelRef).toBeUndefined();
  });
});
