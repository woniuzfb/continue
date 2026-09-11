import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "core";
import { IdeRequestTimeoutError } from "../../context/ideRequestTimeout";
import { createMockStore } from "../../util/test/mockStore";
import { EMPTY_CONFIG, INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import {
  setTelemetryHost,
  type MessageIdMigrationCapability,
} from "../slices/runtimeCapabilitiesSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  initialSessionRuntime,
  type SessionRuntimeState,
} from "../slices/sessionsSlice";
import {
  LEGACY_MESSAGE_ID_EVENT_NAME,
  setLegacyMessageIdEventSink,
  setTelemetryPermissionForTests,
  type LegacyMessageIdEvent,
} from "../util/legacyMessageIdObservability";
import { resetSessionSaveQueues } from "../util/sessionSaveQueue";
import { loadSessionRuntime } from "./sessionActivation";
import {
  maybeMigrateSessionMessageIds,
  resetCapabilityProbeForTests,
  scheduleMessageIdMigrationIfSafe,
} from "./sessionMessageIdMigration";

/**
 * P5a — the emission points, end to end.
 *
 * The P5 audit (§16) found no shared sender; P5a therefore emits local events
 * into a replaceable sink, gated on the host's `isTelemetryEnabled()`. These
 * tests pin:
 *   · the settle semantics (each outcome once; probe failures only at budget
 *     exhaustion; no event on React re-render or non-terminal states);
 *   · the closed field allow-list (no session / message identity);
 *   · that a broken sink and an opted-out host never change business behaviour.
 */

function diskItem(
  role: "user" | "assistant",
  content: string,
  id?: string,
): { message: ChatMessage; contextItems: [] } {
  return {
    message: id
      ? ({ role, content, id } as ChatMessage)
      : ({ role, content } as ChatMessage),
    contextItems: [],
  };
}

function runtimeItem(
  id: string,
  role: "user" | "assistant",
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role,
      content: id,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

const SUPPORTED_IDE_INFO = {
  ideType: "vscode",
  name: "Visual Studio Code",
  version: "1.0.0",
  remoteName: "local",
  extensionVersion: "0.0.0",
  isPrerelease: false,
  capabilities: { historyMigrateIds: true },
} as const;

function configWithUi(ui: Record<string, unknown>) {
  return {
    configError: undefined,
    loading: false,
    config: { ...EMPTY_CONFIG, ui },
  } as any;
}

function makeStore(
  capability: MessageIdMigrationCapability = "unknown",
  host: "vscode" | "intellij" | "other" = "vscode",
  withHistory = true,
) {
  const session = initialSessionRuntime("s1", "Chat 1", {
    // An empty history is not migratable, so the capability-settle tests below
    // observe exactly one event (no follow-on migration event).
    history: (withHistory
      ? [
          {
            message: { id: "s1-u1", role: "user", content: "hi" },
            contextItems: [],
          },
          {
            message: { id: "s1-a1", role: "assistant", content: "yo" },
            contextItems: [],
          },
        ]
      : []) as SessionRuntimeState["history"],
    dirty: false,
    persistence: undefined,
  });
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1: session },
    },
    runtimeCapabilities: {
      historyMigrateIds: capability,
      probeAttempts: 0,
      host,
    },
    config: INITIAL_CONFIG_SLICE,
  });
}

/** A store with a tab that has not been loaded yet (for `loadSessionRuntime`). */
function diskStore() {
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "unloaded" },
      },
      sessionsById: {},
    },
    runtimeCapabilities: {
      historyMigrateIds: "unknown",
      probeAttempts: 0,
      host: "other",
    },
    config: configWithUi({
      lazyLoadHistory: true,
      lazyLoadHistoryInitialCount: 4,
      lazyLoadHistoryPageSize: 4,
    }),
  });
}

let events: LegacyMessageIdEvent[] = [];

function captureEvents() {
  events = [];
  setLegacyMessageIdEventSink((event) => {
    events.push(event);
  });
}

/** Let the fire-and-forget emission microtasks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

beforeEach(() => {
  resetSessionSaveQueues();
  resetCapabilityProbeForTests();
  captureEvents();
  // Default: the host opted in, and the permission is already resolved so the
  // gate itself is not what is under test here.
  setTelemetryPermissionForTests("enabled");
});

describe("capability settle", () => {
  it("emits one `supported` event and never re-emits after it settles", async () => {
    const store = makeStore("unknown", "vscode", false);
    store.mockIdeMessenger.responses["getIdeInfo"] = SUPPORTED_IDE_INFO;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await flush();

    expect(events).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "capability",
        outcome: "supported",
        host: "vscode",
      },
    ]);
    // The host dimension rides on the probe's own `getIdeInfo` — no second call.
    expect(
      request.mock.calls.filter((c) => c[0] === "getIdeInfo"),
    ).toHaveLength(1);
  });

  it("emits one `unsupported` event for a host that declares no capability", async () => {
    const store = makeStore("unknown");

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await flush();

    expect(events).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "capability",
        outcome: "unsupported",
        host: "vscode",
      },
    ]);
  });

  it("normalises the JetBrains ideType to the `intellij` host", async () => {
    const store = makeStore("unknown", "vscode", false);
    store.mockIdeMessenger.responses["getIdeInfo"] = {
      ...SUPPORTED_IDE_INFO,
      ideType: "jetbrains",
    };

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await flush();

    expect(events).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "capability",
        outcome: "supported",
        host: "intellij",
      },
    ]);
  });

  it("emits `probe_failed` only once the bounded budget is spent", async () => {
    const store = makeStore("unknown", "vscode", false);
    store.mockIdeMessenger.request = vi
      .fn()
      .mockRejectedValue(new Error("transport down")) as any;

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await flush();
    expect(events).toEqual([]);

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await flush();
    expect(events).toEqual([]);

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await flush();
    expect(events).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "capability",
        outcome: "probe_failed",
        // No response ⇒ the host was never identified.
        host: "other",
      },
    ]);
  });
});

describe("migration terminal states", () => {
  async function migrateWith(migrateResponse: {
    migrated: boolean;
    addedCount: number;
  }): Promise<LegacyMessageIdEvent[]> {
    const store = makeStore("supported");
    store.mockIdeMessenger.responses["history/migrateIds"] = migrateResponse;
    await run(store, maybeMigrateSessionMessageIds({ sessionId: "s1" }));
    await flush();
    return events;
  }

  it("maps a real rewrite to `written`", async () => {
    expect(await migrateWith({ migrated: true, addedCount: 3 })).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "migration",
        outcome: "written",
        host: "vscode",
      },
    ]);
  });

  it("maps an already-migrated file to `noop`", async () => {
    expect(await migrateWith({ migrated: false, addedCount: 0 })).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "migration",
        outcome: "noop",
        host: "vscode",
      },
    ]);
  });

  it("maps REQUEST_TIMEOUT without calling it a session-file failure", async () => {
    const store = makeStore("supported");
    store.mockIdeMessenger.request = vi
      .fn()
      .mockRejectedValue(
        new IdeRequestTimeoutError("history/migrateIds", 5_000),
      ) as any;
    await run(store, maybeMigrateSessionMessageIds({ sessionId: "s1" }));
    await flush();

    expect(events).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "migration",
        outcome: "request_timeout",
        host: "vscode",
      },
    ]);
  });

  it("maps the two documented error codes to their own outcomes", async () => {
    const invalid = makeStore("supported");
    invalid.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "error",
      errorCode: "SESSION_FILE_INVALID",
      error: "corrupt file at /secret/path.json",
    }) as any;
    await run(invalid, maybeMigrateSessionMessageIds({ sessionId: "s1" }));
    await flush();
    expect(events).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "migration",
        outcome: "session_file_invalid",
        host: "vscode",
      },
    ]);
    // The raw error text (which carries a path) never reaches the event.
    expect(JSON.stringify(events)).not.toContain("/secret/path.json");

    captureEvents();
    const failed = makeStore("supported");
    failed.mockIdeMessenger.request = vi.fn().mockResolvedValue({
      status: "error",
      error: "write failed",
    }) as any;
    await run(failed, maybeMigrateSessionMessageIds({ sessionId: "s1" }));
    await flush();
    expect(events).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "migration",
        outcome: "migration_failed",
        host: "vscode",
      },
    ]);
  });
});

describe("fallback minting", () => {
  it("emits one bucketed event with no session identity", async () => {
    const store = diskStore();
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [diskItem("user", "hi"), diskItem("assistant", "yo")],
      firstTurnItems: [diskItem("user", "hi")],
      hasMore: true,
      total: 4,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };

    await run(store, loadSessionRuntime({ sessionId: "s1" }));
    await flush();

    // The load also settles the (unsupported) capability, so there is a
    // capability event too — the assertion here is about the fallback event.
    const fallbackEvents = events.filter((event) => event.stage === "fallback");
    expect(fallbackEvents).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "fallback",
        outcome: "runtime_ids_minted",
        host: "other",
        countBucket: "2-10",
      },
    ]);
    expect(Object.keys(fallbackEvents[0]).sort()).toEqual([
      "countBucket",
      "host",
      "name",
      "outcome",
      "stage",
    ]);
    // No identity anywhere in the emitted events.
    expect(JSON.stringify(events)).not.toContain("s1");
  });
});

describe("safety", () => {
  it("swallows a throwing sink without failing the session load", async () => {
    const store = diskStore();
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [diskItem("user", "hi")],
      firstTurnItems: [diskItem("user", "hi")],
      hasMore: false,
      total: 1,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };
    setLegacyMessageIdEventSink(() => {
      throw new Error("sink exploded");
    });

    await run(store, loadSessionRuntime({ sessionId: "s1" }));
    await flush();
    expect((store.getState() as any).sessions.sessionsById.s1).toBeDefined();
  });

  it("swallows a rejecting sink without changing the migration outcome", async () => {
    const store = makeStore("supported");
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: true,
      addedCount: 2,
    };
    setLegacyMessageIdEventSink(async () => {
      throw new Error("async sink exploded");
    });

    await run(store, maybeMigrateSessionMessageIds({ sessionId: "s1" }));
    await flush();

    expect(
      (store.getState() as any).sessions.sessionsById.s1.messageIdMigration,
    ).toMatchObject({ state: "succeeded", migrated: true });
  });

  it("emits nothing, and leaves P4a/P4b intact, when the host has opted out", async () => {
    // Permission already resolved to "disabled".
    setTelemetryPermissionForTests("disabled");
    const store = makeStore("unknown");
    store.mockIdeMessenger.responses["getIdeInfo"] = SUPPORTED_IDE_INFO;
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: true,
      addedCount: 1,
    };

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await flush();

    expect(events).toEqual([]);
    // Business state is untouched by the (suppressed) telemetry.
    expect(
      (store.getState() as any).runtimeCapabilities.historyMigrateIds,
    ).toBe("supported");
    expect(
      (store.getState() as any).sessions.sessionsById.s1.messageIdMigration,
    ).toMatchObject({ state: "succeeded", migrated: true });
  });

  it("fails closed when a host answers `false` — no events, migration unchanged", async () => {
    // No pre-set permission: the mock host answers `isTelemetryEnabled: false`.
    setTelemetryPermissionForTests("unknown");
    const store = makeStore("unknown");
    store.mockIdeMessenger.responses["getIdeInfo"] = SUPPORTED_IDE_INFO;
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: true,
      addedCount: 1,
    };
    store.mockIdeMessenger.responses["isTelemetryEnabled"] = false;

    await run(store, scheduleMessageIdMigrationIfSafe({ sessionId: "s1" }));
    await flush();

    expect(events).toEqual([]);
    expect(
      (store.getState() as any).sessions.sessionsById.s1.messageIdMigration,
    ).toMatchObject({ state: "succeeded", migrated: true });
  });

  it("reads the host from the store for a migration event", async () => {
    // The host dimension is captured once by the capability probe; the later
    // migration event reuses it instead of asking again.
    const store = makeStore("supported");
    store.dispatch(setTelemetryHost("intellij"));
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: false,
      addedCount: 0,
    };

    await run(store, maybeMigrateSessionMessageIds({ sessionId: "s1" }));
    await flush();

    expect(events).toEqual([
      {
        name: LEGACY_MESSAGE_ID_EVENT_NAME,
        stage: "migration",
        outcome: "noop",
        host: "intellij",
      },
    ]);
  });
});
