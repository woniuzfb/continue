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
      tabs: {
        tabs: [
          {
            id: "tab-current",
            title: "Current stream",
            isActive: true,
            sessionId: "session-current",
          },
          {
            id: "tab-other",
            title: "Other session",
            isActive: false,
            sessionId: "session-other",
          },
        ],
      },
    });

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>,
    );
    store.clearActions();

    fireEvent.click(screen.getByText("Current stream"));

    expect(store.getActions()).toEqual([]);
  });
});
