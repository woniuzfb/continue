import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";
import { createMockStore } from "../../util/test/mockStore";
import { useAutoScroll } from "./useAutoScroll";

/**
 * Session-isolated scroll position regression tests.
 *
 * Chat stays mounted across tab switches, so the scroll container is shared
 * between sessions. These tests lock down the invariants:
 *
 *  1. A restored mid-scroll viewport is NOT pulled to the bottom by the
 *     ResizeObserver auto-bottom path (the numUserMsgs reset effect must not
 *     fire for a session switch).
 *  2. A session saved at the bottom is restored at the bottom.
 *  3. A session with no saved viewport falls back to the bottom, and the
 *     previous session's scrollTop does not leak into it.
 *  4. Rapid A -> B -> A restores A's viewport (token fencing).
 *
 * Browser behaviors simulated here: assigning scrollTop clamps to
 * [0, scrollHeight - clientHeight]; requestAnimationFrame callbacks are
 * deferred until flushed; ResizeObserver fires an initial callback per
 * observe() and is deactivated by disconnect().
 */

const MAX_SCROLL_TOP = 900; // scrollHeight(1000) - clientHeight(100)

class FakeScrollElement {
  scrollHeight = 1000;
  clientHeight = 100;
  children = [{}] as unknown as HTMLCollection;
  private _scrollTop = 0;
  private listeners: Array<() => void> = [];

  get scrollTop() {
    return this._scrollTop;
  }
  set scrollTop(value: number) {
    // Browsers clamp scrollTop assignments to the scrollable range.
    this._scrollTop = Math.max(0, Math.min(value, MAX_SCROLL_TOP));
  }
  addEventListener(_: string, cb: () => void) {
    this.listeners.push(cb);
  }
  removeEventListener(_: string, cb: () => void) {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }
  dispatchScroll() {
    this.listeners.forEach((l) => l());
  }
}

class ControllableResizeObserver {
  private static active = new Set<ControllableResizeObserver>();
  constructor(private cb: () => void) {}
  observe = vi.fn(() => {
    ControllableResizeObserver.active.add(this);
  });
  unobserve = vi.fn();
  disconnect = vi.fn(() => {
    ControllableResizeObserver.active.delete(this);
  });
  static fireActive() {
    ControllableResizeObserver.active.forEach((i) => i.cb());
  }
  static reset() {
    ControllableResizeObserver.active.clear();
  }
}

// Deferred rAF queue: callbacks run only on flush, like real frames.
let frames: Map<number, () => void> = new Map();
let frameId = 0;

function flushFrames() {
  const pending = [...frames.entries()].sort((a, b) => a[0] - b[0]);
  frames = new Map();
  pending.forEach(([, cb]) => cb());
}

function buildHistory(
  sessionId: string,
  userMsgCount: number,
): ChatHistoryItemWithMessageId[] {
  return Array.from({ length: userMsgCount * 2 }, (_, i) => ({
    message: {
      id: `msg-${sessionId}-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x",
    },
    contextItems: [],
  })) as ChatHistoryItemWithMessageId[];
}

describe("useAutoScroll session-isolated scroll positions", () => {
  let element: FakeScrollElement;

  beforeEach(() => {
    ControllableResizeObserver.reset();
    frames = new Map();
    frameId = 0;
    vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      const id = ++frameId;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });

    element = new FakeScrollElement();
  });

  function mount(initialSessionId: string) {
    const store = createMockStore();
    return renderHook(
      ({
        sessionId,
        userMsgCount,
      }: {
        sessionId: string;
        userMsgCount: number;
      }) => {
        const ref = useRef<HTMLDivElement | null>(null);
        (ref as { current: HTMLDivElement | null }).current =
          element as unknown as HTMLDivElement;
        useAutoScroll(
          ref as React.RefObject<HTMLDivElement>,
          buildHistory(sessionId, userMsgCount),
          sessionId,
        );
        return null;
      },
      {
        initialProps: { sessionId: initialSessionId, userMsgCount: 4 },
        wrapper: ({ children }) => (
          <Provider store={store}>{children}</Provider>
        ),
      },
    );
  }

  // Simulate a user scroll: set position, fire the event, flush the frame.
  function scrollTo(top: number) {
    act(() => {
      element.scrollTop = top;
      element.dispatchScroll();
      flushFrames();
    });
  }

  function switchTo(sessionId: string, userMsgCount: number) {
    act(() => {
      hooks.rerender({ sessionId, userMsgCount });
      flushFrames();
    });
  }

  let hooks: ReturnType<typeof mount>;

  // Complete the mount-time restore frame before interacting, mirroring the
  // browser where the first rAF fires before any user scroll.
  function mountAndSettle(initialSessionId: string) {
    hooks = mount(initialSessionId);
    act(() => {
      flushFrames();
    });
    return hooks;
  }

  it("restores a mid-scroll session without being pulled to the bottom", () => {
    mountAndSettle("session-a");
    scrollTo(400);
    // Leave A (position saved), visit B, then come back.
    switchTo("session-b", 7);
    switchTo("session-a", 4);

    // If the numUserMsgs reset effect fired for the switch, userHasScrolled
    // would be false and this ResizeObserver callback would auto-bottom.
    act(() => {
      ControllableResizeObserver.fireActive();
    });

    expect(element.scrollTop).toBe(400);
  });

  it("restores a session saved at the bottom to the bottom", () => {
    mountAndSettle("session-a");
    scrollTo(MAX_SCROLL_TOP);
    switchTo("session-b", 7);
    switchTo("session-a", 4);

    expect(element.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it("falls back to the bottom for a session with no saved viewport", () => {
    mountAndSettle("session-a");
    scrollTo(250);

    // A's scrollTop (250) must not leak into the fresh session B.
    switchTo("session-b", 7);

    expect(element.scrollTop).toBe(MAX_SCROLL_TOP);
  });

  it("keeps A's viewport through a rapid A -> B -> A switch", () => {
    mountAndSettle("session-a");
    scrollTo(300);
    switchTo("session-b", 7);
    switchTo("session-a", 4);

    expect(element.scrollTop).toBe(300);
  });
});
