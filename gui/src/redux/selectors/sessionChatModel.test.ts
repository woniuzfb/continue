import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { selectSessionChatModel } from "./sessions";

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
