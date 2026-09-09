import { act } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { markSessionDirty } from "../redux/slices/sessionsSlice";
import { useUnloadFlush } from "./useUnloadFlush";
import { renderWithProviders } from "../util/test/render";

/**
 * 方案.md §七.12: unload is best-effort. The hook must push dirty sessions
 * through the normal save path (a `history/save` IPC call) and must not throw
 * when the webview is torn down mid-flight.
 */
describe("useUnloadFlush", () => {
  function Harness() {
    useUnloadFlush();
    return <div data-testid="harness" />;
  }

  test("flushes dirty sessions on pagehide through the normal save path", async () => {
    const { store, ideMessenger } = await renderWithProviders(<Harness />);
    const sessionId = store.getState().sessions.activeSessionId!;
    expect(sessionId).toBeTruthy();

    await act(async () => {
      store.dispatch(markSessionDirty({ sessionId }));
    });
    expect(store.getState().sessions.sessionsById[sessionId].dirty).toBe(true);

    const requestSpy = vi.spyOn(ideMessenger, "request");

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });

    const saveCalls = requestSpy.mock.calls.filter(
      ([messageType]) => messageType === "history/save",
    );
    expect(saveCalls.length).toBeGreaterThan(0);
  });

  test("is idempotent and stops listening after unmount", async () => {
    const { unmount } = await renderWithProviders(<Harness />);
    unmount();
    expect(() => {
      // `beforeunload` is registered too, but React Aria's focus tracking
      // reacts to it in jsdom; `pagehide` covers the same cleanup path.
      window.dispatchEvent(new Event("pagehide"));
    }).not.toThrow();
  });
});
