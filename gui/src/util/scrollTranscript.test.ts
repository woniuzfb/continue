import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollTranscriptToMessage } from "./scrollTranscript";

/**
 * `scrollTranscriptToMessage` must move **only** the transcript container.
 *
 * Regression guard for the reported "clicking Go to previous message cuts the
 * top edge off the session tab": the jump used to call `scrollIntoView`, which
 * scrolls every scrollable ancestor — including the shell (`LayoutTopDiv`'s
 * `overflow-x: auto` and `body`'s `overflow-x: hidden` both compute
 * `overflow-y: auto`), which pushed the tab bar out of the viewport.
 */

function makeContainer(containerTop: number, targetTop: number) {
  const container = document.createElement("div");
  const target = document.createElement("div");
  target.setAttribute("data-message-id", "m1");
  container.appendChild(target);

  container.getBoundingClientRect = () => ({ top: containerTop }) as DOMRect;
  target.getBoundingClientRect = () => ({ top: targetTop }) as DOMRect;
  container.scrollTop = 120;
  return { container, target };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrollTranscriptToMessage", () => {
  it("moves the container by the row's offset and never scrolls an ancestor", () => {
    const { container } = makeContainer(100, 260);
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo as any;
    // jsdom has no layout, and the whole point is that this call must not exist.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as any;

    const moved = scrollTranscriptToMessage(container, "m1");

    expect(moved).toBe(true);
    // 260 - 100 + 120 = 280: the row ends up at the container's top edge.
    expect(scrollTo).toHaveBeenCalledWith({
      top: 280,
      behavior: "smooth",
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("is a no-op when the container or the row is missing", () => {
    const { container } = makeContainer(0, 0);
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo as any;

    expect(scrollTranscriptToMessage(null, "m1")).toBe(false);
    expect(scrollTranscriptToMessage(container, "missing")).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
