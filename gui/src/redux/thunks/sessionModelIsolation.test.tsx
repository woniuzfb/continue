import { screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ModelSelect from "../../components/modelSelection/ModelSelect";
import { SessionScope } from "../../components/mainInput/TipTapEditor/SessionScope";
import { selectSessionChatModel } from "../selectors/sessions";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { projectSessionModelToActiveUi } from "./sessionActivation";
import { setSessionChatModelAndSave } from "./sessionChanges";
import { updateSelectedModelByRole } from "./updateSelectedModelByRole";
import { createMockStore } from "../../util/test/mockStore";
import { triggerConfigUpdate } from "../../util/test/config";
import { renderWithProviders } from "../../util/test/render";

/**
 * 方案.md §7.3.1: a model choice belongs to the window that made it.
 *
 * `ModelSelect` used to write the session's own title **and** the profile-level
 * `config.selectedModelByRole.chat` (persisted through `config/updateSelectedModel`), while
 * `selectSessionChatModel` resolved a session without its own title from that same live global
 * value. So picking a model in one window moved every other window that had never picked one —
 * reproduced as `selectSessionChatModel(other) === the other window's choice`.
 *
 * The session now **freezes** the default it was showing when it is first projected, so a later
 * change elsewhere cannot move it, while a brand-new window still inherits the last choice (the
 * intended "your last pick is the default" behaviour).
 */

const MODELS = [
  { title: "model-a", provider: "openai", model: "a" },
  { title: "model-b", provider: "openai", model: "b" },
];

function makeStore() {
  return createMockStore({
    sessions: {
      activeSessionId: "A",
      tabOrder: ["A", "B"],
      tabDescriptors: {
        A: { sessionId: "A", title: "A", loadState: "loaded" },
        B: { sessionId: "B", title: "B", loadState: "loaded" },
      },
      sessionsById: {
        A: initialSessionRuntime("A", "A"),
        B: initialSessionRuntime("B", "B"),
      },
    },
  });
}

function seedModels(store: ReturnType<typeof makeStore>) {
  const config = (store.getState() as any).config.config;
  store.dispatch({
    type: "config/updateConfig",
    payload: {
      ...config,
      modelsByRole: { ...config.modelsByRole, chat: MODELS },
      selectedModelByRole: {
        ...config.selectedModelByRole,
        chat: MODELS[0],
      },
    },
  });
}

async function activate(
  store: ReturnType<typeof makeStore>,
  sessionId: string,
) {
  store.dispatch({
    type: "sessions/setActiveSessionId",
    payload: { sessionId },
  });
  await act(async () => {
    await store.dispatch(
      projectSessionModelToActiveUi({
        sessionId,
        chatModelTitle: undefined,
      }) as any,
    );
  });
}

describe("a model choice stays in the window that made it (方案.md §7.3.1)", () => {
  it("freezes the default each session was showing", async () => {
    const store = makeStore();
    seedModels(store);

    await activate(store, "A");
    await activate(store, "B");

    const afterFreeze = store.getState() as any;
    expect(afterFreeze.sessions.sessionsById.A.chatModelTitle).toBe("model-a");
    expect(afterFreeze.sessions.sessionsById.B.chatModelTitle).toBe("model-a");
  });

  it("does not move another window when one window changes its model", async () => {
    const store = makeStore();
    seedModels(store);
    await activate(store, "A");
    await activate(store, "B");

    // Window A picks model-b, exactly like ModelSelect does today (session write + profile
    // default). The profile write is intentional: it is the default for *new* windows.
    store.dispatch({
      type: "sessions/setActiveSessionId",
      payload: { sessionId: "A" },
    });
    await act(async () => {
      await store.dispatch(
        updateSelectedModelByRole({
          role: "chat",
          modelTitle: "model-b",
          selectedProfile: { id: "local" } as any,
        }) as any,
      );
      await store.dispatch(
        setSessionChatModelAndSave({
          sessionId: "A",
          chatModelTitle: "model-b",
        }) as any,
      );
    });

    const state = store.getState() as any;
    expect(selectSessionChatModel(state, "A")?.title).toBe("model-b");
    // The other window keeps what it was showing…
    expect(state.sessions.sessionsById.B.chatModelTitle).toBe("model-a");
    expect(selectSessionChatModel(state, "B")?.title).toBe("model-a");
    // …while the profile default follows the choice, for windows created from now on.
    expect(state.config.config.selectedModelByRole.chat.title).toBe("model-b");
  });

  it("lets a session created afterwards inherit the current default", async () => {
    const store = makeStore();
    seedModels(store);
    // Two windows are already open, so both are already showing model-a …
    await activate(store, "A");
    await activate(store, "B");

    store.dispatch({
      type: "sessions/setActiveSessionId",
      payload: { sessionId: "A" },
    });
    await act(async () => {
      await store.dispatch(
        updateSelectedModelByRole({
          role: "chat",
          modelTitle: "model-b",
          selectedProfile: { id: "local" } as any,
        }) as any,
      );
      await store.dispatch(
        setSessionChatModelAndSave({
          sessionId: "A",
          chatModelTitle: "model-b",
        }) as any,
      );
    });

    // A brand-new window adopts the profile default (the last explicit choice) …
    store.dispatch({
      type: "sessions/createSessionRuntime",
      payload: { session: initialSessionRuntime("C", "C") },
    });
    await activate(store, "C");
    expect(
      (store.getState() as any).sessions.sessionsById.C.chatModelTitle,
    ).toBe("model-b");
    expect(selectSessionChatModel(store.getState() as any, "C")?.title).toBe(
      "model-b",
    );
    // …while the window that chose model-a earlier is still on model-a.
    expect(selectSessionChatModel(store.getState() as any, "B")?.title).toBe(
      "model-a",
    );
  });

  it("shows each window its own model, not the last global choice", async () => {
    const store = makeStore();
    seedModels(store);
    await activate(store, "A");
    await activate(store, "B");

    // B's window is the one on screen; A has already picked model-b.
    const { ideMessenger } = await renderWithProviders(
      <SessionScope sessionId="B">
        <ModelSelect />
      </SessionScope>,
      { store: store as any },
    );
    // The config arrives through the real webview message, like production: the *profile default*
    // is model-b (A's choice), while B's session kept model-a.
    await act(async () => {
      triggerConfigUpdate({
        store,
        ideMessenger,
        editConfig(current) {
          current.modelsByRole.chat = MODELS as any;
          current.selectedModelByRole.chat = MODELS[1] as any;
          return current;
        },
      });
    });
    store.dispatch({
      type: "sessions/setActiveSessionId",
      payload: { sessionId: "B" },
    });

    expect(screen.getByTestId("model-select-button").textContent).toContain(
      "model-a",
    );
  });
});
