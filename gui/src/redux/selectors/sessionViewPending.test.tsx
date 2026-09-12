import { act, renderHook } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdeMessengerProvider } from "../../context/IdeMessenger";
import { SessionScope } from "../../components/mainInput/TipTapEditor/SessionScope";
import { createMockStore } from "../../util/test/mockStore";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import {
  setPendingSubmission,
  clearPendingSubmission,
} from "../slices/sessionsSlice";
import {
  PENDING_SUBMISSION_SHOW_DELAY_MS,
  useSessionPendingSubmission,
} from "./sessionView";
import {
  stallFromTick,
  startMainThreadStallDetector,
  stopMainThreadStallDetector,
} from "../../util/submitLatency";
import { captureSubmitLatencyLines } from "../../util/test/submitLatencyCapture";

/**
 * Workflow "submit latency and retry boundary": the two presentation-level guards.
 *
 * 1. The pending draft is **withheld** for a short window. Once the commit moved ahead of the
 *    lazy-load hydration, a send commits in ~13–26ms — so an always-on draft appeared,
 *    shifted the layout and was replaced almost immediately: the jitter around the message
 *    the user just sent, plus a flash of the replace-target dimming.
 * 2. The stall clock: it separates "the main thread was blocked" from "the reply was queued"
 *    for the gap between the host answering a save and this side handling it.
 */

function makeStore() {
  const s1 = initialSessionRuntime("s1", "Chat 1", { history: [] });
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

const wrapperFor = (store: ReturnType<typeof makeStore>) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <Provider store={store}>
        <IdeMessengerProvider messenger={store.mockIdeMessenger}>
          <SessionScope sessionId="s1">{children}</SessionScope>
        </IdeMessengerProvider>
      </Provider>
    );
  };

const draft = (startedAt: number, submissionId = "sub-1") => ({
  submissionId,
  status: "resolving-context" as const,
  insertion: { kind: "append" as const },
  displayContent: "hello",
  startedAt,
});

describe("pending draft presentation delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays hidden while the send is still fast", () => {
    const store = makeStore();
    store.dispatch(
      setPendingSubmission({
        sessionId: "s1",
        submission: draft(Date.now()),
      }),
    );

    const { result } = renderHook(() => useSessionPendingSubmission(), {
      wrapper: wrapperFor(store),
    });

    // Nothing yet: a send that commits in ~20ms must not flash anything.
    expect(result.current).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(PENDING_SUBMISSION_SHOW_DELAY_MS - 50);
    });
    expect(result.current).toBeUndefined();

    // Still preparing after the delay ⇒ now it is worth showing.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current?.submissionId).toBe("sub-1");
  });

  it("never shows a draft that is cleared before the delay elapses", () => {
    const store = makeStore();
    store.dispatch(
      setPendingSubmission({
        sessionId: "s1",
        submission: draft(Date.now()),
      }),
    );
    const { result } = renderHook(() => useSessionPendingSubmission(), {
      wrapper: wrapperFor(store),
    });

    // The commit landed: the state is gone before the delay, so the row is never rendered and
    // the transcript never shifts for it.
    act(() => {
      store.dispatch(
        clearPendingSubmission({ sessionId: "s1", submissionId: "sub-1" }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(PENDING_SUBMISSION_SHOW_DELAY_MS * 2);
    });
    expect(result.current).toBeUndefined();
  });

  it("shows an already-old draft immediately", () => {
    const store = makeStore();
    store.dispatch(
      setPendingSubmission({
        sessionId: "s1",
        submission: draft(Date.now() - PENDING_SUBMISSION_SHOW_DELAY_MS - 500),
      }),
    );

    const { result } = renderHook(() => useSessionPendingSubmission(), {
      wrapper: wrapperFor(store),
    });
    expect(result.current?.submissionId).toBe("sub-1");
  });
});

describe("main-thread stall clock", () => {
  let capture: ReturnType<typeof captureSubmitLatencyLines>;

  beforeEach(() => {
    capture = captureSubmitLatencyLines();
  });
  afterEach(() => {
    capture.restore();
    stopMainThreadStallDetector();
  });

  it("reports only a real overrun", () => {
    // A timer asked to fire every 100ms that took 120ms is normal scheduling noise.
    expect(stallFromTick(100, 120)).toBeUndefined();
    // …but a thread that was not running for a second is the thing we are looking for.
    expect(stallFromTick(100, 1100)).toBe(1000);
    expect(stallFromTick(100, 350)).toBe(250); // exactly at the threshold
    expect(stallFromTick(100, 349)).toBeUndefined();
  });

  it("starts and stops idempotently", () => {
    expect(() => {
      startMainThreadStallDetector();
      startMainThreadStallDetector();
      stopMainThreadStallDetector();
      stopMainThreadStallDetector();
    }).not.toThrow();
  });
});
