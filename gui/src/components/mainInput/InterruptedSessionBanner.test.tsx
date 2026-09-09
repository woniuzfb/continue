import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
import InterruptedSessionBanner from "./InterruptedSessionBanner";

function makeStore(interrupted: boolean) {
  const s1 = initialSessionRuntime("s1", "Chat 1", { interrupted });
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1 },
    },
  });
}

describe("InterruptedSessionBanner", () => {
  it("offers Retry and Dismiss for an interrupted session", () => {
    const store = makeStore(true);
    render(
      <Provider store={store}>
        <InterruptedSessionBanner />
      </Provider>,
    );

    expect(screen.getByText("Retry")).toBeTruthy();
    expect(screen.getByText("Dismiss")).toBeTruthy();
  });

  it("renders nothing for a normal session", () => {
    const store = makeStore(false);
    const { container } = render(
      <Provider store={store}>
        <InterruptedSessionBanner />
      </Provider>,
    );

    expect(container.textContent).toBe("");
  });
});
