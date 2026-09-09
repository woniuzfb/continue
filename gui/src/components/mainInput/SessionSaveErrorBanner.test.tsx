import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
import SessionSaveErrorBanner from "./SessionSaveErrorBanner";
import { SessionScope } from "./TipTapEditor/SessionScope";

function makeStore(persistenceState: "clean" | "failed") {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    persistence:
      persistenceState === "failed"
        ? {
            state: "failed",
            revision: 2,
            persistedRevision: 1,
            hasPersistedBaseline: true,
            error: { code: "SESSION_SAVE_FAILED", message: "disk full" },
          }
        : {
            state: "clean",
            revision: 2,
            persistedRevision: 2,
            hasPersistedBaseline: true,
          },
    dirty: persistenceState === "failed",
  });
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

describe("SessionSaveErrorBanner", () => {
  it("shows the failure code and a retry entry", () => {
    const store = makeStore("failed");
    render(
      <Provider store={store}>
        <SessionScope sessionId="s1">
          <SessionSaveErrorBanner />
        </SessionScope>
      </Provider>,
    );

    expect(screen.getByText(/disk full/)).toBeTruthy();
    expect(screen.getByText("Retry save")).toBeTruthy();
  });

  it("renders nothing while the session is clean", () => {
    const store = makeStore("clean");
    const { container } = render(
      <Provider store={store}>
        <SessionScope sessionId="s1">
          <SessionSaveErrorBanner />
        </SessionScope>
      </Provider>,
    );

    expect(container.textContent).toBe("");
  });
});
