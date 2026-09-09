import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import {
  setActiveSessionModeAndSave,
  setActiveSessionReasoningAndSave,
  setSessionChatModelAndSave,
} from "./sessionChanges";

function makeStore() {
  const s1 = initialSessionRuntime("s1", "Chat 1", { mode: "chat" });
  const s2 = initialSessionRuntime("s2", "Chat 2", { mode: "agent" });
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
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
          chat: [
            { title: "gpt-4o", provider: "openai", model: "gpt-4o" } as any,
          ],
        },
      },
    },
  });
}

function session(store: ReturnType<typeof makeStore>, id = "s1") {
  return (store.getState() as any).sessions.sessionsById[id];
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("session change saves", () => {
  beforeEach(() => resetSessionSaveQueues());

  it("saves on a mode change for the active session", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, setActiveSessionModeAndSave({ mode: "plan" }));

    expect(session(store).mode).toBe("plan");
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
  });

  it("saves on a reasoning change", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, setActiveSessionReasoningAndSave({ enabled: true }));

    expect(session(store).hasReasoningEnabled).toBe(true);
    // 方案.md §七.8: an explicit choice is persisted with its source, so a
    // reload does not silently fall back to the derived default.
    expect(session(store).reasoningPreferenceSource).toBe("explicit");
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({
          sessionId: "s1",
          hasReasoningEnabled: true,
          reasoningPreferenceSource: "explicit",
        }),
      );
    });
  });

  it("records a user model choice on the target session and projects it", async () => {
    const store = makeStore();

    await run(
      store,
      setSessionChatModelAndSave({
        sessionId: "s1",
        chatModelTitle: "gpt-4o",
      }),
    );

    expect(session(store).chatModelTitle).toBe("gpt-4o");
    expect(
      (store.getState() as any).config.activeSessionModelProjection?.title,
    ).toBe("gpt-4o");
    // A background session's choice is not projected onto the active UI.
    await run(
      store,
      setSessionChatModelAndSave({
        sessionId: "s2",
        chatModelTitle: "gpt-4o",
      }),
    );
    expect(
      (store.getState() as any).config.activeSessionModelProjection?.title,
    ).toBe("gpt-4o");
    expect(session(store, "s2").chatModelTitle).toBe("gpt-4o");
  });
});
