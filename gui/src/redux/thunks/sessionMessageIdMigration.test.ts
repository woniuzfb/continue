import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdeRequestTimeoutError } from "../../context/ideRequestTimeout";
import { createMockStore } from "../../util/test/mockStore";
import { selectSessionById } from "../selectors/sessions";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { MessageIdMigrationCapability } from "../slices/runtimeCapabilitiesSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  initialSessionRuntime,
  type SessionRuntimeState,
} from "../slices/sessionsSlice";
import {
  resetSessionSaveQueues,
  setPendingSave,
} from "../util/sessionSaveQueue";
import { needsContextMetricsRecompute } from "./sessionMetrics";
import {
  canMigrateSessionMessageIds,
  IDE_INFO_TIMEOUT_MS,
  MESSAGE_ID_MIGRATION_TIMEOUT_MS,
  maybeMigrateSessionMessageIds,
  probeHostCapabilities,
  resetCapabilityProbeForTests,
  scheduleMessageIdMigrationIfSafe,
} from "./sessionMessageIdMigration";

/**
 * P4a. What has to hold:
 *
 *  1. `unsupported` comes from a **host-declared capability**, never from an
 *     error or a timeout — an unknown `messageType` is answered with nothing at
 *     all, so a request to an old host hangs and leaks its listener.
 *  2. A declared capability that times out is `failed/REQUEST_TIMEOUT`, not
 *     `unsupported`: "declared but did not answer" ≠ "cannot do this".
 *  3. The gate never writes to a session that is mid-flight.
 *  4. Migration must not look like a conversation change: no dirty flag, no
 *     `historyRevision` move, no metrics invalidation, no `history/save`.
 */

function item(
  id: string,
  role: "user" | "assistant",
  content = id,
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role,
      content,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

/** A valid snapshot: identity / schema / historyRevision all still match. */
const METRICS_SNAPSHOT = {
  didPrune: false,
  contextPercentage: 0.42,
  inputTokens: 1_234,
  contextLength: 100_000,
};

const METRICS_META = {
  // No chat model is configured, so the session's identity is "".
  modelIdentity: "",
  historyRevision: 0,
  schemaVersion: 1,
};

type SessionSpec = Partial<SessionRuntimeState>;

function makeSession(id: string, overrides: SessionSpec = {}) {
  return initialSessionRuntime(id, id === "s1" ? "Chat 1" : "Chat 2", {
    history: [
      item(`${id}-u1`, "user", "hi"),
      item(`${id}-a1`, "assistant", "yo"),
    ],
    dirty: false,
    // `sessionActivation` never sets `persistence`, so a runtime loaded from
    // disk really does carry `undefined` here.
    persistence: undefined,
    ...overrides,
  });
}

function makeStore(
  sessionOverrides: Record<string, SessionSpec> = { s1: {} },
  capability: MessageIdMigrationCapability = "supported",
  activeSessionId?: string,
) {
  const ids = Object.keys(sessionOverrides);
  const sessionsById: Record<string, SessionRuntimeState> = {};
  for (const id of ids) {
    sessionsById[id] = makeSession(id, sessionOverrides[id]);
  }
  return createMockStore({
    sessions: {
      activeSessionId: activeSessionId ?? ids[0],
      tabOrder: ids,
      tabDescriptors: Object.fromEntries(
        ids.map((id) => [
          id,
          { sessionId: id, title: id, loadState: "loaded" as const },
        ]),
      ),
      sessionsById,
    },
    runtimeCapabilities: { historyMigrateIds: capability, probeAttempts: 0 },
    config: INITIAL_CONFIG_SLICE,
  });
}

type Store = ReturnType<typeof makeStore>;

function session(store: Store, id = "s1") {
  return selectSessionById(store.getState() as any, id)!;
}

function requestTypes(store: Store, request: { mock: { calls: any[][] } }) {
  return request.mock.calls.map((call) => call[0]);
}

function run(store: Store, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

/** A modern host: answers `getIdeInfo` and declares the capability. */
const SUPPORTED_IDE_INFO = {
  ideType: "vscode",
  name: "Visual Studio Code",
  version: "1.0.0",
  remoteName: "local",
  extensionVersion: "0.0.0",
  isPrerelease: false,
  capabilities: { historyMigrateIds: true as const },
};

describe("scheduleMessageIdMigrationIfSafe — host capability", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    // The probe's single-flight slot is module-level (it coordinates the whole
    // process, not one store), so it must not leak between tests.
    resetCapabilityProbeForTests();
  });

  it("never sends history/migrateIds to a host that does not declare it", async () => {
    // The default mock `getIdeInfo` carries no `capabilities` field: an old host.
    const store = makeStore({ s1: {} }, "unknown");
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

    expect(requestTypes(store, request)).toEqual(["getIdeInfo"]);
    expect(
      (store.getState() as any).runtimeCapabilities.historyMigrateIds,
    ).toBe("unsupported");
    expect(session(store).messageIdMigration).toEqual({ state: "unsupported" });
  });

  it("probes the host through getIdeInfo, with a timeout, exactly once", async () => {
    const store = makeStore({ s1: {} }, "unknown");
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

    expect(request).toHaveBeenCalledWith("getIdeInfo", undefined, {
      timeoutMs: IDE_INFO_TIMEOUT_MS,
    });
    expect(requestTypes(store, request)).toEqual(["getIdeInfo"]);
    expect((store.getState() as any).runtimeCapabilities.probeAttempts).toBe(1);
  });

  it("sends the migration only when the host declares the capability", async () => {
    const store = makeStore({ s1: {} }, "supported");
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: true,
      addedCount: 3,
    };
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

    // A settled capability means no probe at all.
    expect(request).toHaveBeenCalledWith(
      "history/migrateIds",
      { id: "s1" },
      { timeoutMs: MESSAGE_ID_MIGRATION_TIMEOUT_MS },
    );
    expect(requestTypes(store, request)).toEqual(["history/migrateIds"]);
    expect(session(store).messageIdMigration).toEqual({
      state: "succeeded",
      migrated: true,
      addedCount: 3,
    });
  });

  it("treats 'nothing to migrate' as a success no-op", async () => {
    const store = makeStore({ s1: {} }, "supported");
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: false,
      addedCount: 0,
    };

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

    expect(session(store).messageIdMigration).toEqual({
      state: "succeeded",
      migrated: false,
      addedCount: 0,
    });
  });

  it("reports a host stall as probe-failed, not as a session failure", async () => {
    const store = makeStore({ s1: {} }, "unknown");
    store.mockIdeMessenger.request = vi
      .fn()
      .mockRejectedValue(
        new IdeRequestTimeoutError("getIdeInfo", IDE_INFO_TIMEOUT_MS),
      ) as any;

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

    const state = store.getState() as any;
    expect(state.runtimeCapabilities.historyMigrateIds).toBe("probe-failed");
    // Nothing is attributed to the session file, and nothing was sent.
    expect(session(store).messageIdMigration).toEqual({
      state: "not-requested",
    });
  });

  it("bounds probe retries and never overlaps two flights", async () => {
    const store = makeStore({ s1: {} }, "unknown");
    let concurrent = 0;
    let maxConcurrent = 0;
    const requestTypesSeen: string[] = [];
    const request = vi.fn().mockImplementation(async (messageType: string) => {
      requestTypesSeen.push(messageType);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      throw new IdeRequestTimeoutError("getIdeInfo", IDE_INFO_TIMEOUT_MS);
    });
    store.mockIdeMessenger.request = request as any;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
      // Each failure is a complete, sequential flight.
      expect((store.getState() as any).runtimeCapabilities.probeAttempts).toBe(
        attempt + 1,
      );
    }
    // Budget spent: two more triggers must not send anything.
    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

    expect(request).toHaveBeenCalledTimes(3);
    expect(maxConcurrent).toBe(1);
    expect(requestTypesSeen).toEqual([
      "getIdeInfo",
      "getIdeInfo",
      "getIdeInfo",
    ]);
  });

  it("does not mark unsupported when only the log/migrate probe fails", async () => {
    const store = makeStore({ s1: {} }, "unknown");
    // `probeHostCapabilities` on its own never writes a per-session state.
    store.mockIdeMessenger.request = vi
      .fn()
      .mockRejectedValue(new Error("transport down")) as any;

    await run(store, probeHostCapabilities());

    expect(session(store).messageIdMigration).toEqual({
      state: "not-requested",
    });
    expect(
      (store.getState() as any).runtimeCapabilities.historyMigrateIds,
    ).toBe("probe-failed");
  });
});

/**
 * P4a.1. The capability is a global host fact with several independent
 * triggers — the boot probe in `ParallelListeners` and the load / save /
 * stream / paging kicks — and the first two fire from different effects in the
 * same commit. Without single-flight each one sends its own `getIdeInfo`:
 *
 *   A: unknown/0 → attempts=1 → await
 *   B: unknown/1 → attempts=2 → await
 *   C: unknown/2 → attempts=3 → await
 *
 * which burns the retry budget on start-up concurrency and opens extra
 * listeners that only a timeout reclaims. Worse, a late failure from one flight
 * could land after another flight's success and downgrade `supported` to
 * `probe-failed`, silently disabling migration on a host that supports it.
 */
describe("probeHostCapabilities — single flight", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetCapabilityProbeForTests();
  });

  it("sends one getIdeInfo for concurrent triggers and reuses its answer", async () => {
    const store = makeStore({ s1: {}, s2: {} }, "unknown", "s1");
    let releaseInfo: (value: any) => void = () => {};
    const infoGate = new Promise((resolve) => {
      releaseInfo = resolve;
    });
    const request = vi.fn().mockImplementation(async (messageType: string) => {
      if (messageType === "getIdeInfo") {
        return infoGate;
      }
      return {
        status: "success",
        content: { migrated: true, addedCount: 1 },
        done: true,
      };
    });
    store.mockIdeMessenger.request = request as any;

    // Three independent triggers, all fired before the first answer arrives.
    const first = run(store, probeHostCapabilities());
    const second = run(
      store,
      scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }),
    );
    const third = run(
      store,
      scheduleMessageIdMigrationIfSafe({ sessionId: "s2" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    const infoCalls = () =>
      request.mock.calls.filter((call) => call[0] === "getIdeInfo");
    expect(infoCalls()).toHaveLength(1);
    expect((store.getState() as any).runtimeCapabilities.probeAttempts).toBe(1);

    releaseInfo({ status: "success", content: SUPPORTED_IDE_INFO, done: true });
    await Promise.all([first, second, third]);

    // One request, one attempt, and every waiter used the same answer.
    expect(infoCalls()).toHaveLength(1);
    expect((store.getState() as any).runtimeCapabilities.probeAttempts).toBe(1);
    expect(
      (store.getState() as any).runtimeCapabilities.historyMigrateIds,
    ).toBe("supported");
    expect(
      request.mock.calls.filter((call) => call[0] === "history/migrateIds"),
    ).toHaveLength(2);
    expect(session(store, "s1").messageIdMigration).toMatchObject({
      state: "succeeded",
    });
    expect(session(store, "s2").messageIdMigration).toMatchObject({
      state: "succeeded",
    });
  });

  it("does not let a superseded flight overwrite a newer answer", async () => {
    const store = makeStore({ s1: {} }, "unknown");
    let releaseStale: (value: any) => void = () => {};
    const staleGate = new Promise((resolve) => {
      releaseStale = resolve;
    });
    let infoCalls = 0;
    const request = vi.fn().mockImplementation(async (messageType: string) => {
      if (messageType !== "getIdeInfo") {
        throw new Error(`unexpected ${messageType}`);
      }
      infoCalls += 1;
      // The first flight hangs; the second answers immediately.
      return infoCalls === 1
        ? staleGate
        : { status: "success", content: SUPPORTED_IDE_INFO, done: true };
    });
    store.mockIdeMessenger.request = request as any;

    const stale = run(store, probeHostCapabilities());
    await Promise.resolve();

    // Simulate the slot being reclaimed (the test-only escape hatch) so a newer
    // flight can start while the old one is still in the air.
    resetCapabilityProbeForTests();
    await run(store, probeHostCapabilities());
    expect(
      (store.getState() as any).runtimeCapabilities.historyMigrateIds,
    ).toBe("supported");

    // The stale flight now fails, long after the newer answer landed.
    releaseStale({ status: "error", error: "too late", done: true });
    await stale;

    expect(
      (store.getState() as any).runtimeCapabilities.historyMigrateIds,
    ).toBe("supported");
  });

  it("never re-probes a settled capability, from any trigger", async () => {
    for (const settled of ["supported", "unsupported"] as const) {
      const store = makeStore({ s1: {} }, settled);
      store.mockIdeMessenger.responses["history/migrateIds"] = {
        migrated: false,
        addedCount: 0,
      };
      const request = vi.spyOn(store.mockIdeMessenger, "request");

      await run(store, probeHostCapabilities());
      await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
      await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

      expect(
        request.mock.calls.filter((call) => call[0] === "getIdeInfo"),
        `${settled} must never be re-probed`,
      ).toHaveLength(0);
    }
  });
});

describe("maybeMigrateSessionMessageIds — outcomes", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    // The probe's single-flight slot is module-level (it coordinates the whole
    // process, not one store), so it must not leak between tests.
    resetCapabilityProbeForTests();
  });

  function failingStore(errorCode: string, error = "boom") {
    const store = makeStore({ s1: {} }, "supported");
    store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "error",
      error,
      errorCode,
      done: true,
    }) as any;
    return store;
  }

  it("keeps the structured SESSION_FILE_INVALID code", async () => {
    const store = failingStore("SESSION_FILE_INVALID", "file is not JSON");

    await run(store, maybeMigrateSessionMessageIds({ sessionId: "s1" }));

    expect(session(store).messageIdMigration).toEqual({
      state: "failed",
      code: "SESSION_FILE_INVALID",
      message: "file is not JSON",
    });
  });

  it("keeps the structured MESSAGE_ID_MIGRATION_FAILED code", async () => {
    const store = failingStore("MESSAGE_ID_MIGRATION_FAILED", "write failed");

    await run(store, maybeMigrateSessionMessageIds({ sessionId: "s1" }));

    expect(session(store).messageIdMigration).toEqual({
      state: "failed",
      code: "MESSAGE_ID_MIGRATION_FAILED",
      message: "write failed",
    });
  });

  it("reports a declared-but-unanswered request as REQUEST_TIMEOUT", async () => {
    const store = makeStore({ s1: {} }, "supported");
    store.mockIdeMessenger.request = vi
      .fn()
      .mockRejectedValue(
        new IdeRequestTimeoutError(
          "history/migrateIds",
          MESSAGE_ID_MIGRATION_TIMEOUT_MS,
        ),
      ) as any;

    await run(store, maybeMigrateSessionMessageIds({ sessionId: "s1" }));

    const migration = session(store).messageIdMigration;
    expect(migration.state).toBe("failed");
    expect(migration).toMatchObject({ code: "REQUEST_TIMEOUT" });
    // A timeout is never `unsupported`: the host declared the capability.
    expect(migration.state).not.toBe("unsupported");
  });

  it("attempts each session at most once, whatever the outcome", async () => {
    const store = makeStore({ s1: {} }, "supported");
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: true,
      addedCount: 1,
    };
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await run(store, maybeMigrateSessionMessageIds({ sessionId: "s1" }));

    expect(requestTypes(store, request)).toEqual(["history/migrateIds"]);
    expect(session(store).messageIdMigration).toMatchObject({
      state: "succeeded",
    });
  });
});

describe("canMigrateSessionMessageIds — gate", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    // The probe's single-flight slot is module-level (it coordinates the whole
    // process, not one store), so it must not leak between tests.
    resetCapabilityProbeForTests();
  });

  function can(store: Store, id = "s1") {
    return canMigrateSessionMessageIds(store.getState() as any, id);
  }

  it("allows a clean session loaded from disk", () => {
    expect(can(makeStore({ s1: {} }))).toBe(true);
  });

  it("refuses without the host capability", () => {
    expect(can(makeStore({ s1: {} }, "unknown"))).toBe(false);
    expect(can(makeStore({ s1: {} }, "unsupported"))).toBe(false);
    expect(can(makeStore({ s1: {} }, "probe-failed"))).toBe(false);
  });

  it("refuses a session that has never been saved (history.length === 0)", () => {
    // Otherwise Core answers SESSION_FILE_INVALID and the user sees a fake
    // "migration failed" for a brand-new, never-saved tab.
    expect(can(makeStore({ s1: { history: [] } }))).toBe(false);
  });

  it("refuses a dirty session", () => {
    expect(can(makeStore({ s1: { dirty: true } }))).toBe(false);
  });

  it("refuses a live request, even when the stream looks idle", () => {
    // awaiting-approval and waiting-for-apply are `idle` + a live requestId.
    expect(
      can(
        makeStore({
          s1: { stream: { status: "idle", requestId: "req-1" } },
        }),
      ),
    ).toBe(false);
    expect(can(makeStore({ s1: { stream: { status: "streaming" } } }))).toBe(
      false,
    );
    expect(can(makeStore({ s1: { stream: { status: "failed" } } }))).toBe(
      false,
    );
  });

  it("refuses while paging or persisting", () => {
    expect(
      can(
        makeStore({
          s1: {
            pagination: { ...makeSession("s1").pagination, loading: true },
          },
        }),
      ),
    ).toBe(false);
    expect(
      can(
        makeStore({
          s1: {
            pagination: {
              ...makeSession("s1").pagination,
              persistPending: true,
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("treats a missing persistence record as safe and any other state as unsafe", () => {
    expect(can(makeStore({ s1: { persistence: undefined } }))).toBe(true);
    expect(
      can(
        makeStore({
          s1: {
            persistence: {
              state: "clean",
              revision: 1,
              persistedRevision: 1,
              hasPersistedBaseline: true,
            },
          },
        }),
      ),
    ).toBe(true);
    for (const state of ["pending", "saving", "failed"] as const) {
      expect(
        can(
          makeStore({
            s1: {
              persistence: {
                state,
                revision: 2,
                persistedRevision: 1,
                hasPersistedBaseline: true,
              },
            },
          }),
        ),
        `persistence.state === ${state} must block`,
      ).toBe(false);
    }
  });

  it("refuses a session that is no longer not-requested", () => {
    for (const migration of [
      { state: "pending" as const },
      { state: "unsupported" as const },
      { state: "succeeded" as const, migrated: true, addedCount: 1 },
    ]) {
      expect(can(makeStore({ s1: { messageIdMigration: migration } }))).toBe(
        false,
      );
    }
  });

  it("refuses while the module-level save queue still owns a write", async () => {
    // `persistence.state` is a projection that can lag the queue, so the queue
    // itself has to be consulted. Simulate a queued save for a session whose
    // Redux state still says `clean`.
    const store = makeStore({ s1: {} }, "supported");
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    setPendingSave("s1", { revision: 0, reason: "test" });

    try {
      expect(can(store)).toBe(false);
      await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
      expect(
        request.mock.calls.some((call) => call[0] === "history/migrateIds"),
      ).toBe(false);
    } finally {
      resetSessionSaveQueues();
    }
  });
});

describe("migration never looks like a conversation change", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    // The probe's single-flight slot is module-level (it coordinates the whole
    // process, not one store), so it must not leak between tests.
    resetCapabilityProbeForTests();
  });

  it("leaves both sessions' context metrics untouched while B is active", async () => {
    const store = makeStore(
      {
        s1: {
          contextMetrics: METRICS_SNAPSHOT,
          contextMetricsMeta: METRICS_META,
        },
        s2: {
          contextMetrics: METRICS_SNAPSHOT,
          contextMetricsMeta: METRICS_META,
        },
      },
      "supported",
      "s2",
    );
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: true,
      addedCount: 7,
    };
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const beforeA = session(store, "s1");
    const metricsA = beforeA.contextMetrics;
    const metaA = beforeA.contextMetricsMeta;
    const metricsB = session(store, "s2").contextMetrics;
    const metaB = session(store, "s2").contextMetricsMeta;

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

    expect(session(store, "s1").messageIdMigration).toMatchObject({
      state: "succeeded",
    });
    // Same references, not just equal values: the circle must not blink.
    expect(session(store, "s1").contextMetrics).toBe(metricsA);
    expect(session(store, "s1").contextMetricsMeta).toBe(metaA);
    expect(session(store, "s2").contextMetrics).toBe(metricsB);
    expect(session(store, "s2").contextMetricsMeta).toBe(metaB);
    expect(session(store, "s1").contextPercentage).toBe(
      beforeA.contextPercentage,
    );
    // No recompute, and no write: the migration is not a conversation change.
    expect(needsContextMetricsRecompute(store.getState() as any, "s1")).toBe(
      false,
    );
    expect(needsContextMetricsRecompute(store.getState() as any, "s2")).toBe(
      false,
    );
    expect((store.getState() as any).sessions.activeSessionId).toBe("s2");
    expect(requestTypes(store, request)).not.toContain("llm/compileChat");
    expect(requestTypes(store, request)).not.toContain("history/save");
  });

  it("does not advance historyRevision or dirty the session on success", async () => {
    const store = makeStore(
      {
        s1: {
          contextMetrics: METRICS_SNAPSHOT,
          contextMetricsMeta: METRICS_META,
        },
      },
      "supported",
    );
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: true,
      addedCount: 2,
    };

    const before = session(store);
    const historyRevision = before.historyRevision;
    const historyReference = before.history;
    const persistenceRevision = before.persistence?.revision;

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

    const after = session(store);
    expect(after.historyRevision).toBe(historyRevision);
    expect(after.history).toBe(historyReference);
    expect(after.dirty).toBe(false);
    expect(after.persistence?.revision).toBe(persistenceRevision);
    expect(needsContextMetricsRecompute(store.getState() as any, "s1")).toBe(
      false,
    );
    expect(after.contextMetrics).toBe(METRICS_SNAPSHOT);
    expect(after.contextMetricsMeta).toBe(METRICS_META);
  });

  it("keeps the snapshot through failure, unsupported and timeout", async () => {
    const cases: Array<{
      name: string;
      arrange: (store: Store) => void;
      capability: MessageIdMigrationCapability;
      expected: string;
    }> = [
      {
        name: "SESSION_FILE_INVALID",
        capability: "supported",
        arrange: (store) => {
          store.mockIdeMessenger.request = vi.fn().mockResolvedValue({
            status: "error",
            error: "bad file",
            errorCode: "SESSION_FILE_INVALID",
            done: true,
          }) as any;
        },
        expected: "failed",
      },
      {
        name: "MESSAGE_ID_MIGRATION_FAILED",
        capability: "supported",
        arrange: (store) => {
          store.mockIdeMessenger.request = vi
            .fn()
            .mockRejectedValue(new Error("write failed")) as any;
        },
        expected: "failed",
      },
      {
        name: "REQUEST_TIMEOUT",
        capability: "supported",
        arrange: (store) => {
          store.mockIdeMessenger.request = vi
            .fn()
            .mockRejectedValue(
              new IdeRequestTimeoutError(
                "history/migrateIds",
                MESSAGE_ID_MIGRATION_TIMEOUT_MS,
              ),
            ) as any;
        },
        expected: "failed",
      },
      {
        name: "unsupported host",
        capability: "unknown",
        arrange: () => {},
        expected: "unsupported",
      },
    ];

    for (const testCase of cases) {
      const store = makeStore(
        {
          s1: {
            contextMetrics: METRICS_SNAPSHOT,
            contextMetricsMeta: METRICS_META,
          },
        },
        testCase.capability,
      );
      testCase.arrange(store);

      await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));

      const after = session(store);
      expect(after.messageIdMigration.state, testCase.name).toBe(
        testCase.expected,
      );
      // Not cleared, not reset to zero, no error surfaced here.
      expect(after.contextMetrics, testCase.name).toBe(METRICS_SNAPSHOT);
      expect(after.contextMetricsMeta, testCase.name).toBe(METRICS_META);
      expect(after.contextPercentage, testCase.name).toBeUndefined();
      expect(
        (after as any).messageIdMigration.error,
        testCase.name,
      ).toBeUndefined();
      expect(
        needsContextMetricsRecompute(store.getState() as any, "s1"),
        testCase.name,
      ).toBe(false);
    }
  });
});
