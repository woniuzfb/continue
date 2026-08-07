import { describe, expect, it } from "vitest";

import { isTransientStreamError } from "./errorAnalysis";

describe("isTransientStreamError", () => {
  it("classifies socket/network errors as transient", () => {
    expect(isTransientStreamError(new Error("socket hang up"))).toBe(true);
    expect(isTransientStreamError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientStreamError(new Error("connect ECONNREFUSED"))).toBe(
      true,
    );
    expect(isTransientStreamError(new Error("fetch failed"))).toBe(true);
    expect(isTransientStreamError(new Error("network error"))).toBe(true);
    expect(isTransientStreamError(new Error("ETIMEDOUT"))).toBe(true);
    expect(
      isTransientStreamError(new Error("UND_ERR_SOCKET: socket closed")),
    ).toBe(true);
  });

  it("classifies SSE/stream termination errors as transient", () => {
    expect(isTransientStreamError(new Error("premature close"))).toBe(true);
    expect(isTransientStreamError(new Error("unexpected end of input"))).toBe(
      true,
    );
    expect(isTransientStreamError(new Error("Connection terminated"))).toBe(
      true,
    );
    expect(isTransientStreamError(new Error("stream error"))).toBe(true);
  });

  it("classifies 5xx and 408 status codes as transient", () => {
    for (const code of [408, 500, 502, 503, 504]) {
      expect(isTransientStreamError(new Error(`HTTP ${code}`), code)).toBe(
        true,
      );
      expect(
        isTransientStreamError({
          message: "oops",
          response: { status: code },
        }),
      ).toBe(true);
    }
  });

  it("never treats user aborts as transient", () => {
    expect(
      isTransientStreamError(new Error("This operation was aborted")),
    ).toBe(false);
    expect(isTransientStreamError(new Error("aborted"))).toBe(false);
    expect(isTransientStreamError(new Error("request canceled"))).toBe(false);
  });

  it("never treats permanent errors as transient", () => {
    expect(isTransientStreamError(new Error("401 Unauthorized"))).toBe(false);
    expect(isTransientStreamError(new Error("invalid API key"))).toBe(false);
    expect(isTransientStreamError(new Error("404 not found"))).toBe(false);
    expect(isTransientStreamError(new Error("403 Forbidden"))).toBe(false);
    expect(
      isTransientStreamError(new Error("maximum context length exceeded")),
    ).toBe(false);
    expect(isTransientStreamError(new Error("content filter"))).toBe(false);
    expect(isTransientStreamError(new Error("insufficient balance"))).toBe(
      false,
    );
  });

  it("leaves 429/overloaded to the existing silent retry path", () => {
    expect(isTransientStreamError(new Error("overloaded"))).toBe(false);
    expect(isTransientStreamError(new Error("529"))).toBe(false);
    expect(isTransientStreamError(new Error("rate limit"), 429)).toBe(false);
  });

  it("returns false for empty/unknown errors", () => {
    expect(isTransientStreamError(undefined)).toBe(false);
    expect(isTransientStreamError(null)).toBe(false);
    expect(isTransientStreamError(new Error(""))).toBe(false);
    expect(isTransientStreamError(new Error("some random error"))).toBe(false);
  });
});
