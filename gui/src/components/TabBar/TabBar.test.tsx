import { fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { TabBar } from "./TabBar";

describe("TabBar", () => {
  it("does not reload or save when the active streaming tab is clicked", () => {
    const initialState = getEmptyRootState();
    initialState.session.id = "session-current";
    initialState.session.title = "Current stream";
    initialState.session.isStreaming = true;
    initialState.session.history = [
      {
        message: { id: "message-1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.tabs.tabs = [
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
    ];
    const store = createMockStore(initialState);

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
