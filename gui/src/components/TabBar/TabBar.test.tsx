import { fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
  it("does not reload or save when the active streaming tab is clicked", () => {
    // 方案.md §九: the runtime owns the session; the tab bar projects it.
    const store = createMockStore({
      sessions: {
        activeSessionId: "session-current",
        tabOrder: ["session-current", "session-other"],
        tabDescriptors: {
          "session-current": {
            sessionId: "session-current",
            title: "Current stream",
            loadState: "loaded",
          },
          "session-other": {
            sessionId: "session-other",
            title: "Other session",
            loadState: "loaded",
          },
        },
        sessionsById: {
          "session-current": initialSessionRuntime(
            "session-current",
            "Current stream",
            {
              history: [
                {
                  message: {
                    id: "message-1",
                    role: "user",
                    content: "Hello",
                  } as any,
                  contextItems: [],
                },
              ],
              stream: { status: "streaming", requestId: "req-1" },
            },
          ),
        },
      },
    });

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>,
    );
    store.clearActions();

    // Clicking the already-active tab must not switch or save anything.
    fireEvent.click(screen.getByText("Current stream"));

    expect(store.getActions()).toEqual([]);
  });
});

describe("TabBar failure projection", () => {
  it("shows a retry affordance for a session whose save failed", () => {
    const store = createMockStore({
      sessions: {
        activeSessionId: "s1",
        tabOrder: ["s1", "s2"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Failed", loadState: "loaded" },
          s2: { sessionId: "s2", title: "Other", loadState: "loaded" },
        },
        sessionsById: {
          s1: initialSessionRuntime("s1", "Failed", {
            persistence: {
              state: "failed",
              revision: 1,
              persistedRevision: 0,
              hasPersistedBaseline: false,
              error: { code: "SESSION_SAVE_FAILED", message: "disk full" },
            },
            dirty: true,
          }),
          s2: initialSessionRuntime("s2", "Other"),
        },
      },
    });

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>,
    );

    expect(screen.getByTitle("Save failed - click to retry")).toBeTruthy();
  });
});
