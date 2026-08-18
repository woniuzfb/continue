import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";
import { useAppSelector } from "../../redux/hooks";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
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

/**
 * Fill-viewport auto-pagination regression tests.
 *
 * Bug: with lazyLoadHistory on, a session opened from View History whose
 * initial page (tail N items) renders shorter than the viewport has NO
 * scrollable overflow → the scroll event never fires → the top-of-scroll
 * lazy loader can never run → the user sees only the last exchange and
 * cannot scroll up. The fix measures the viewport after mount/prepend and
 * proactively calls loadMoreHistory until the content is scrollable or the
 * history is exhausted.
 *
 * Here the fake element's scrollHeight is tied to the store's history length
 * (30px per item) so pagination naturally "fills" the 100px viewport after
 * one 4-item page.
 */
class ShrinkwrapScrollElement {
  clientHeight = 100;
  children = [{}] as unknown as HTMLCollection;
  itemHeight = 30;
  historyLength = 0;
  private listeners: Array<() => void> = [];

  get scrollHeight() {
    return this.historyLength * this.itemHeight;
  }
  get scrollTop() {
    return 0; // never scrollable while under-filled
  }
  set scrollTop(_: number) {}
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

function diskItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    message: { role: i % 2 === 0 ? "user" : "assistant", content: `d-${i}` },
    contextItems: [],
  }));
}

describe("useAutoScroll fill-viewport auto-pagination (lazy history deadlock)", () => {
  let element: ShrinkwrapScrollElement;

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
    element = new ShrinkwrapScrollElement();
  });

  function mountLazy(initialHistoryCount: number) {
    const state = getEmptyRootState() as any;
    state.session.id = "lazy-session";
    state.session.history = diskItems(initialHistoryCount).map((it: any) => ({
      ...it,
      message: { ...it.message, id: `m-${it.message.content}` },
    }));
    state.session.historyTruncated = true;
    state.session.hasMoreHistory = true;
    state.session.historyLoadedOffset = 20 - initialHistoryCount;
    state.session.loadedDiskCount = initialHistoryCount;
    state.session.isStreaming = false;
    state.session.isHistoryLoading = false;
    const store = createMockStore(state);
    element.historyLength = initialHistoryCount;
    // Sync the fake height with the store as pages are prepended.
    store.subscribe(() => {
      element.historyLength = (store.getState() as any).session.history.length;
    });

    const hooks = renderHook(
      () => {
        const ref = useRef<HTMLDivElement | null>(null);
        (ref as { current: HTMLDivElement | null }).current =
          element as unknown as HTMLDivElement;
        const history = useAppSelector((s) => s.session.history);
        useAutoScroll(
          ref as React.RefObject<HTMLDivElement>,
          history,
          "lazy-session",
        );
        return null;
      },
      {
        wrapper: ({ children }) => (
          <Provider store={store}>{children}</Provider>
        ),
      },
    );
    return { hooks, store };
  }

  async function settle(times = 12) {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        flushFrames();
        await Promise.resolve();
      });
      if (frames.size === 0) break;
    }
  }

  it("auto-paginates when the lazy initial page is shorter than the viewport", async () => {
    const { store } = mountLazy(2);
    const handler = vi.fn(
      ({ offset, limit }: { offset: number; limit: number }) => {
        // 20-item disk; return the page immediately before the loaded tail.
        const items = diskItems(20)
          .slice(20 - offset - limit, 20 - offset)
          .map((it: any) => ({
            ...it,
            message: { ...it.message, id: `d-${it.message.content}` },
          }));
        return {
          items,
          hasMore: 20 - offset - limit > 0,
          total: 20,
          session: {
            title: "t",
            mode: "chat",
            chatModelTitle: undefined,
            workspaceDirectory: "ws",
            contextMetrics: undefined,
          },
        };
      },
    );
    store.mockIdeMessenger.responseHandlers["history/loadPage"] =
      handler as any;

    await settle();

    // 2 items (60px) under-fill the 100px viewport → one 4-item page is
    // prepended → 6 items (180px) now overflow → loading stops.
    expect(handler).toHaveBeenCalledTimes(1);
    const s = (store.getState() as any).session;
    expect(s.history.length).toBe(6);
    expect(s.history[0].message.content).toBe("d-14");
    expect(s.hasMoreHistory).toBe(true);
  });

  it("stops retrying after repeated failed page loads (no infinite loop)", async () => {
    const { store } = mountLazy(2);
    const handler = vi.fn(() => {
      throw new Error("disk read failed");
    });
    store.mockIdeMessenger.responseHandlers["history/loadPage"] =
      handler as any;

    await settle();

    // Failed loads never grow history → attempts cap at 3, then give up.
    expect(handler.mock.calls.length).toBeLessThanOrEqual(3);
    expect((store.getState() as any).session.history.length).toBe(2);
  });

  it("does not paginate when content already overflows the viewport", async () => {
    // 10 items * 30px = 300px > 100px viewport → scrollable → no auto-page.
    const { store } = mountLazy(10);
    const handler = vi.fn();
    store.mockIdeMessenger.responseHandlers["history/loadPage"] =
      handler as any;

    await settle();

    expect(handler).not.toHaveBeenCalled();
  });
});
