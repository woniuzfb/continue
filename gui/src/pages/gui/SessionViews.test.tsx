import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
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
