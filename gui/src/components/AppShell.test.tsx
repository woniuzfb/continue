import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";
import { createMockStore } from "../util/test/mockStore";
import { renderWithProviders } from "../util/test/render";
import { initialSessionRuntime } from "../redux/slices/sessionsSlice";
import { resetEnsureActiveSessionLoad } from "../redux/thunks/sessionLifecycle";

/**
 * 方案.md §九.0: the shell must render without any tab and without a
 * `MainEditorProvider`. The per-tab provider lives inside `SessionLayout`.
 */
describe("AppShell", () => {
  it("renders the sidebar and the bootstrap placeholder with no tab", async () => {
    resetEnsureActiveSessionLoad();
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
    // Keep the startup pipeline pending so the placeholder stays observable.
    store.mockIdeMessenger.responseHandlers["history/list"] = () =>
      new Promise(() => {});

    const { container } = await renderWithProviders(<AppShell />, {
      store: store as any,
    });

    expect(container.querySelector("aside")).not.toBeNull();
    expect(
      container.querySelector("[data-testid='session-bootstrap']"),
    ).not.toBeNull();
    // No tab tree, therefore no editor instance owned by the shell.
    expect(container.querySelector("[data-testid^='editor-input']")).toBeNull();
  });
});
