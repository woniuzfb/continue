import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdeRequestTimeoutError } from "../../context/ideRequestTimeout";
import {
  bucketFallbackCount,
  emitLegacyFallbackMintedEvent,
  emitLegacyMessageIdEvent,
  emitLegacyMessageIdEventIfEnabled,
  LEGACY_MESSAGE_ID_EVENT_NAME,
  resetLegacyMessageIdEventSink,
  resetLegacyMessageIdObservabilityForTests,
  resolveTelemetryPermission,
  setLegacyMessageIdEventSink,
  setTelemetryPermissionForTests,
  TELEMETRY_PERMISSION_TIMEOUT_MS,
  telemetryHostFromIdeType,
  type LegacyMessageIdEvent,
  type TelemetryPermissionMessenger,
} from "./legacyMessageIdObservability";

/**
 * P5a unit tests for the event layer itself: the pure mappers, the sink seam,
 * and the fail-closed opt-out gate (including its single-flight probe).
 */

const EVENT: LegacyMessageIdEvent = {
  name: LEGACY_MESSAGE_ID_EVENT_NAME,
  stage: "capability",
  outcome: "supported",
  host: "vscode",
};

function messengerResolving(
  value:
    | { status: "success"; content: boolean }
    | { status: "error"; error: string },
) {
  return {
    request: vi.fn(async () => value),
  } as unknown as TelemetryPermissionMessenger;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetLegacyMessageIdObservabilityForTests();
});

describe("telemetryHostFromIdeType", () => {
  it("is the single place the host spelling is decided", () => {
    expect(telemetryHostFromIdeType("vscode")).toBe("vscode");
    expect(telemetryHostFromIdeType("jetbrains")).toBe("intellij");
    expect(telemetryHostFromIdeType("something-else")).toBe("other");
    expect(telemetryHostFromIdeType(undefined)).toBe("other");
    // Case sensitivity is part of the fixed contract.
    expect(telemetryHostFromIdeType("VSCode")).toBe("other");
    expect(telemetryHostFromIdeType("JetBrains")).toBe("other");
  });
});

describe("bucketFallbackCount", () => {
  it("pins the bucket boundaries", () => {
    expect(bucketFallbackCount(1)).toBe("1");
    expect(bucketFallbackCount(2)).toBe("2-10");
    expect(bucketFallbackCount(10)).toBe("2-10");
    expect(bucketFallbackCount(11)).toBe("11-50");
    expect(bucketFallbackCount(50)).toBe("11-50");
    expect(bucketFallbackCount(51)).toBe("51-200");
    expect(bucketFallbackCount(200)).toBe("51-200");
    expect(bucketFallbackCount(201)).toBe("201+");
  });
});

describe("event sink", () => {
  it("defaults to a silent no-op", () => {
    expect(() => emitLegacyMessageIdEvent(EVENT)).not.toThrow();
  });

  it("hands the exact event to a replaced sink, and reset restores the no-op", () => {
    const seen: LegacyMessageIdEvent[] = [];
    setLegacyMessageIdEventSink((event) => {
      seen.push(event);
    });
    emitLegacyMessageIdEvent(EVENT);
    expect(seen).toEqual([EVENT]);

    resetLegacyMessageIdEventSink();
    emitLegacyMessageIdEvent(EVENT);
    expect(seen).toEqual([EVENT]); // unchanged — the original sink is gone
  });

  it("swallows a synchronous sink throw", () => {
    setLegacyMessageIdEventSink(() => {
      throw new Error("boom");
    });
    expect(() => emitLegacyMessageIdEvent(EVENT)).not.toThrow();
  });

  it("swallows an asynchronous sink rejection", async () => {
    setLegacyMessageIdEventSink(async () => {
      throw new Error("async boom");
    });

    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", onUnhandled);
    emitLegacyMessageIdEvent(EVENT);
    await flush();
    await flush();
    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toBe(false);
  });
});

describe("opt-out gate", () => {
  it("enables and emits only when the host answers true", async () => {
    const seen: LegacyMessageIdEvent[] = [];
    setLegacyMessageIdEventSink((event) => {
      seen.push(event);
    });
    const messenger = messengerResolving({ status: "success", content: true });

    await emitLegacyMessageIdEventIfEnabled(EVENT, messenger);

    expect(seen).toEqual([EVENT]);
    expect(messenger.request).toHaveBeenCalledWith(
      "isTelemetryEnabled",
      undefined,
      { timeoutMs: TELEMETRY_PERMISSION_TIMEOUT_MS },
    );
  });

  it("sends nothing when the host answers false", async () => {
    const seen: LegacyMessageIdEvent[] = [];
    setLegacyMessageIdEventSink((event) => {
      seen.push(event);
    });
    const messenger = messengerResolving({ status: "success", content: false });

    await emitLegacyMessageIdEventIfEnabled(EVENT, messenger);

    expect(seen).toEqual([]);
  });

  it("fails closed on an error response", async () => {
    const seen: LegacyMessageIdEvent[] = [];
    setLegacyMessageIdEventSink((event) => {
      seen.push(event);
    });
    const messenger = messengerResolving({
      status: "error",
      error: "no handler",
    });

    await emitLegacyMessageIdEventIfEnabled(EVENT, messenger);

    expect(seen).toEqual([]);
  });

  it("fails closed on a timeout (unknown messageType) and does not retry", async () => {
    const seen: LegacyMessageIdEvent[] = [];
    setLegacyMessageIdEventSink((event) => {
      seen.push(event);
    });
    const request = vi.fn(async () => {
      throw new IdeRequestTimeoutError("isTelemetryEnabled", 3_000);
    });
    const messenger = { request } as unknown as TelemetryPermissionMessenger;

    await emitLegacyMessageIdEventIfEnabled(EVENT, messenger);
    await emitLegacyMessageIdEventIfEnabled(EVENT, messenger);

    expect(seen).toEqual([]);
    // The result is cached: a webview lifetime probes at most once.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent first-time callers onto one probe (single-flight)", async () => {
    let resolveRequest: (value: {
      status: "success";
      content: boolean;
    }) => void = () => {};
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve as typeof resolveRequest;
        }),
    );
    const messenger = { request } as unknown as TelemetryPermissionMessenger;

    const first = emitLegacyMessageIdEventIfEnabled(EVENT, messenger);
    const second = emitLegacyMessageIdEventIfEnabled(EVENT, messenger);
    expect(request).toHaveBeenCalledTimes(1);

    resolveRequest({ status: "success", content: true });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not probe again once the permission is resolved", async () => {
    const messenger = messengerResolving({ status: "success", content: true });

    await resolveTelemetryPermission(messenger);
    await resolveTelemetryPermission(messenger);

    expect(messenger.request).toHaveBeenCalledTimes(1);
    expect(await resolveTelemetryPermission(messenger)).toBe("enabled");
  });
});

describe("fallback event helper", () => {
  it("builds a closed, bucketed event and never carries identity", async () => {
    setTelemetryPermissionForTests("enabled");
    const seen: LegacyMessageIdEvent[] = [];
    setLegacyMessageIdEventSink((event) => {
      seen.push(event);
    });

    emitLegacyFallbackMintedEvent({
      mintedCount: 12,
      host: "vscode",
      messenger: messengerResolving({ status: "success", content: true }),
    });
    await flush();

    expect(seen).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "fallback",
        outcome: "runtime_ids_minted",
        host: "vscode",
        countBucket: "11-50",
      },
    ]);
    expect(Object.keys(seen[0]).sort()).toEqual([
      "countBucket",
      "host",
      "name",
      "outcome",
      "stage",
    ]);
  });
});
