import { beforeEach, describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import type { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
import { createMockStore } from "../../util/test/mockStore";
import { resetEnsureActiveSessionLoad } from "../../redux/thunks/sessionLifecycle";
import { renderWithProviders } from "../../util/test/render";
import { SessionViews } from "./SessionViews";

function item(id: string, content: string): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role: "assistant",
      content,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

describe("SessionViews", () => {
  beforeEach(() => resetEnsureActiveSessionLoad());

  it("renders a scoped placeholder instead of a bare Chat while there is no tab", async () => {
    // Chat calls useSessionId(), which throws outside a SessionScope. A store
    // whose runtime exists but whose tab projection is empty (first boot before
    // bootstrap, or the last tab was just closed) must not render it.
    const store = createMockStore({
      sessions: {
        activeSessionId: undefined,
        tabOrder: [],
        tabDescriptors: {},
        sessionsById: {
          orphan: initialSessionRuntime("orphan", "Orphan"),
        },
      },
    });
    // Keep the startup pipeline pending so the placeholder state is observable.
    store.mockIdeMessenger.responseHandlers["history/list"] = () =>
      new Promise(() => {});

    const { container } = await renderWithProviders(<SessionViews />, {
      store: store as any,
    });

    expect(
      container.querySelector("[data-testid='session-bootstrap']"),
    ).not.toBeNull();
    // No Chat tree (and therefore no editor) without a scope.
    expect(container.querySelector("[data-testid^='editor-input']")).toBeNull();
    expect((store.getState() as any).sessions.tabOrder).toEqual([]);
  });

  it("mounts the scoped tab tree once the startup pipeline created a session", async () => {
    const store = createMockStore({
      sessions: {
        activeSessionId: undefined,
        tabOrder: [],
        tabDescriptors: {},
        sessionsById: {
          orphan: initialSessionRuntime("orphan", "Orphan"),
        },
      },
    });

    const { container } = await renderWithProviders(<SessionViews />, {
      store: store as any,
    });

    await waitFor(() => {
      expect((store.getState() as any).sessions.tabOrder).toHaveLength(1);
    });
    await waitFor(() => {
      // SessionScope + MainEditorProvider + Chat, each with its own editor.
      expect(
        container.querySelector("[data-testid^='editor-input']"),
      ).not.toBeNull();
    });
  });

  it("registers a per-tab global shortcut only for the visible tab", async () => {
    // Cmd+. cycles the mode. Every mounted tab renders its own ModeSelect, so
    // without a visibility gate one keystroke would cycle once per open tab
    // (方案.md §九.2).
    const store = createMockStore({
      sessions: {
        activeSessionId: "tab-a",
        tabOrder: ["tab-a", "tab-b"],
        tabDescriptors: {
          "tab-a": { sessionId: "tab-a", title: "A", loadState: "loaded" },
          "tab-b": { sessionId: "tab-b", title: "B", loadState: "loaded" },
        },
        sessionsById: {
          "tab-a": initialSessionRuntime("tab-a", "A", { mode: "agent" }),
          "tab-b": initialSessionRuntime("tab-b", "B", { mode: "agent" }),
        },
      },
    });

    await renderWithProviders(<SessionViews />, { store: store as any });
    store.clearActions();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: ".", metaKey: true }),
      );
    });

    const modeChanges = store
      .getActions()
      .filter((action: any) => action.type === "sessions/setSessionMode");
    expect(modeChanges).toHaveLength(1);
    expect((store.getState() as any).sessions.sessionsById["tab-a"].mode).toBe(
      "chat",
    );
  });

  it("keeps one mounted tree per tab and hides the inactive one", async () => {
    const { store, container } = await renderWithProviders(<SessionViews />);
    const state = store.getState() as any;
    const first = state.sessions.activeSessionId;

    store.dispatch({
      type: "sessions/createSessionRuntime",
      payload: {
        session: initialSessionRuntime("session-two", "Second", {
          history: [item("b1", "second session content")],
        }),
      },
    });
    store.dispatch({
      type: "sessions/createSessionRuntime",
      payload: {
        session: initialSessionRuntime(first, "First", {
          history: [item("a1", "first session content")],
        }),
      },
    });
    store.dispatch({
      type: "sessions/setActiveSessionId",
      payload: { sessionId: first },
    });

    // Wait for the trees to render.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const wrappers = container.querySelectorAll<HTMLDivElement>(
      "div[style*='display']",
    );
    const sessionWrappers = Array.from(wrappers).filter((node) =>
      node.className.includes("flex-1"),
    );
    expect(sessionWrappers).toHaveLength(2);

    const visible = sessionWrappers.filter(
      (node) => node.style.display === "flex",
    );
    const hidden = sessionWrappers.filter(
      (node) => node.style.display === "none",
    );
    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(1);

    // The active tree shows its own session's content; the hidden tree keeps
    // its own (mounted, not unmounted).
    expect(visible[0].textContent).toContain("first session content");
    expect(hidden[0].textContent).toContain("second session content");
    // Each tree owns an editor input (its own provider instance).
    expect(
      visible[0].querySelector("[data-testid^='editor-input']"),
    ).not.toBeNull();
    expect(
      hidden[0].querySelector("[data-testid^='editor-input']"),
    ).not.toBeNull();
  });
});
