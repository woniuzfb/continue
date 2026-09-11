import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdeMessenger } from "./IdeMessenger";
import {
  IdeRequestTimeoutError,
  isIdeRequestTimeoutError,
} from "./ideRequestTimeout";

/**
 * `IdeMessenger.request` used to have exactly one cleanup point: the response
 * handler. A host that does not recognise a `messageType` never responds, so
 * the promise stayed pending forever *and* its `window` "message" listener was
 * never removed — one leaked listener plus closure per attempt, which an outer
 * `Promise.race` cannot clean up because it only ends the caller's own control
 * flow.
 *
 * These tests pin the fix at the layer that can actually clean up: the promise
 * rejects, the listener is removed first, and a late response is dropped.
 */

function capturePostedMessages(messenger: IdeMessenger) {
  const posted: { messageType: string; messageId: string }[] = [];
  const impl = ((
    messageType: string,
    _data: unknown,
    messageId: string,
  ): void => {
    posted.push({ messageType, messageId });
  }) as any;
  vi.spyOn(messenger as any, "_postToIde").mockImplementation(impl);
  return posted;
}

function respond(messageId: string, content: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        messageId,
        data: { status: "success", content, done: true },
      },
    }),
  );
}

function messageHandlers(spy: { mock: { calls: any[][] } }): unknown[] {
  return spy.mock.calls
    .filter((call) => call[0] === "message")
    .map((call) => call[1]);
}

describe("IdeMessenger.request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("removes its window listener before rejecting on timeout", async () => {
    const messenger = new IdeMessenger();
    const posted = capturePostedMessages(messenger);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const promise = messenger.request("getIdeInfo", undefined, {
      timeoutMs: 5_000,
    });
    // The promise executor runs synchronously, so the listener already exists.
    const [handler] = messageHandlers(addSpy);
    expect(handler).toBeTypeOf("function");
    expect(posted).toHaveLength(1);

    let settlements = 0;
    void promise.catch(() => {
      settlements += 1;
    });

    vi.advanceTimersByTime(5_000);
    await expect(promise).rejects.toBeInstanceOf(IdeRequestTimeoutError);
    await Promise.resolve();

    // The listener is gone: this is the leak the timeout exists to prevent.
    expect(messageHandlers(removeSpy)).toEqual([handler]);
    expect(settlements).toBe(1);

    // A late response must be dropped, not settle the promise a second time.
    respond(posted[0].messageId, { ideType: "vscode" });
    await Promise.resolve();
    await Promise.resolve();
    expect(settlements).toBe(1);
  });

  it("rejects with a typed, code-addressable error", async () => {
    const messenger = new IdeMessenger();
    capturePostedMessages(messenger);

    const promise = messenger.request(
      "history/migrateIds",
      { id: "s1" },
      {
        timeoutMs: 5_000,
      },
    );
    vi.advanceTimersByTime(5_000);

    const error = await promise.catch((e: unknown) => e);
    // Branch on `code`, never on the message text.
    expect(isIdeRequestTimeoutError(error)).toBe(true);
    const typed = error as IdeRequestTimeoutError;
    expect(typed.code).toBe("IDE_REQUEST_TIMEOUT");
    expect(typed.messageType).toBe("history/migrateIds");
    expect(typed.timeoutMs).toBe(5_000);
  });

  it("clears the timer on a normal response", async () => {
    const messenger = new IdeMessenger();
    const posted = capturePostedMessages(messenger);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    const promise = messenger.request("getIdeInfo", undefined, {
      timeoutMs: 5_000,
    });
    const [handler] = messageHandlers(addSpy);

    respond(posted[0].messageId, { ideType: "vscode" });
    await expect(promise).resolves.toEqual({
      status: "success",
      content: { ideType: "vscode" },
      done: true,
    });

    expect(clearSpy).toHaveBeenCalled();
    expect(messageHandlers(removeSpy)).toEqual([handler]);
  });

  it("makes concurrent requests clean up only their own handler", async () => {
    const messenger = new IdeMessenger();
    const posted = capturePostedMessages(messenger);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const first = messenger.request("getIdeInfo", undefined, {
      timeoutMs: 1_000,
    });
    const second = messenger.request("getIdeInfo", undefined, {
      timeoutMs: 1_000,
    });
    const handlers = messageHandlers(addSpy);
    expect(handlers).toHaveLength(2);
    expect(messageHandlers(removeSpy)).toHaveLength(0);

    respond(posted[1].messageId, { ideType: "vscode" });
    await expect(second).resolves.toBeTruthy();
    expect(messageHandlers(removeSpy)).toEqual([handlers[1]]);

    vi.advanceTimersByTime(1_000);
    await expect(first).rejects.toBeInstanceOf(IdeRequestTimeoutError);
    expect(messageHandlers(removeSpy)).toEqual([handlers[1], handlers[0]]);
  });

  it("keeps the historical never-timeout behaviour when no timeout is given", async () => {
    const messenger = new IdeMessenger();
    capturePostedMessages(messenger);

    const promise = messenger.request("getIdeInfo", undefined);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    vi.advanceTimersByTime(10 * 60 * 1000);
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});
