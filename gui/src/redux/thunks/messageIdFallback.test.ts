import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistoryItem } from "core";
import { createMockStore } from "../../util/test/mockStore";
import {
  type MessageIdMigrationCapability,
  selectMessageIdMigrationCapability,
} from "../slices/runtimeCapabilitiesSlice";
import { EMPTY_CONFIG } from "../slices/configSlice";
import {
  initialSessionRuntime,
  type SessionRuntimeState,
} from "../slices/sessionsSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  resetMessageIdFallbackReporter,
  setMessageIdFallbackReporter,
  type MessageIdFallbackReport,
} from "../util/messageIdFallbackReport";
import { resetSessionSaveQueues } from "../util/sessionSaveQueue";
import { loadSessionRuntime } from "./sessionActivation";
import { loadFullHistory, loadMoreHistory } from "./sessionPaging";
import { saveSession } from "./sessionPersistence";

/**
 * P4b-2. The GUI fallback (`ensureMessageIds`) stays in place for hosts that
 * return no ids, but every load path now **reports** that it had to mint.
 *
 * The two things this file pins:
 *   1. a fallback is a normal, silent, non-error path — it must not fail a load,
 *      mark the session dirty, advance `historyRevision`, or flip the migration
 *      state to `succeeded` (fallback ≠ migrated);
 *   2. the report appears on all four paths — initial load, loadMore, loadFull
 *      and the save response's first turn — and only when something was minted.
 */

function diskItem(
  role: "user" | "assistant",
  content: string,
  id?: string,
): ChatHistoryItem {
  return {
    message: id
      ? ({ role, content, id } as ChatHistoryItem["message"])
      : ({ role, content } as ChatHistoryItem["message"]),
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

function configWithUi(ui: Record<string, unknown>) {
  return {
    configError: undefined,
    loading: false,
    config: { ...EMPTY_CONFIG, ui },
  } as any;
}

/** A store with a tab that has not been loaded yet (for `loadSessionRuntime`). */
function diskStore(
  capability: MessageIdMigrationCapability = "unknown",
  ui: Record<string, unknown> = {
    lazyLoadHistory: true,
    lazyLoadHistoryInitialCount: 4,
    lazyLoadHistoryPageSize: 4,
  },
) {
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
      historyMigrateIds: capability,
      probeAttempts: 0,
      host: "other",
    },
    config: configWithUi(ui),
  });
}

/** A store with a loaded, truncated runtime (for paging / save). */
function runtimeStore(
  overrides: Partial<SessionRuntimeState> = {},
  capability: MessageIdMigrationCapability = "supported",
) {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [runtimeItem("u1", "user"), runtimeItem("a1", "assistant")],
    pagination: {
      truncated: true,
      loadedOffset: 2,
      totalCount: 6,
      loadedDiskCount: 2,
      hasMore: true,
      loading: false,
      requestGeneration: 0,
      persistPending: false,
    },
    ...overrides,
  });
  const store = createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1 },
    },
    runtimeCapabilities: {
      historyMigrateIds: capability,
      probeAttempts: 0,
      host: "other",
    },
    config: configWithUi({
      lazyLoadHistory: true,
      lazyLoadHistoryInitialCount: 2,
      lazyLoadHistoryPageSize: 4,
    }),
  });
  // These tests are about the *fallback report*, not the migration. A supported
  // capability makes every safe-state transition fire one, so give it a quiet
  // no-op answer instead of letting the mock reject an undefined response.
  store.mockIdeMessenger.responses["history/migrateIds"] = {
    migrated: false,
    addedCount: 0,
  };
  return store;
}

function sessionOf(store: { getState: () => unknown }) {
  return (store.getState() as any).sessions.sessionsById.s1 as
    | SessionRuntimeState
    | undefined;
}

function run(store: ReturnType<typeof diskStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

function captureReports() {
  const reports: MessageIdFallbackReport[] = [];
  setMessageIdFallbackReporter((report) => reports.push(report));
  return reports;
}

describe("message-id fallback reporting", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
  });

  afterEach(() => {
    resetMessageIdFallbackReporter();
  });

  it("reports the initial load's minted ids and never treats them as migrated", async () => {
    // The default mock host declares no capability: this is the ordinary
    // legacy path, and minting here must stay silent for the user.
    const store = diskStore();
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [diskItem("user", "hi"), diskItem("assistant", "yo")],
      firstTurnItems: [diskItem("user", "hi")],
      hasMore: true,
      total: 4,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };
    const reports = captureReports();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, loadSessionRuntime({ sessionId: "s1" }));

    // 2 paged history items + 1 page first-turn item.
    expect(reports).toEqual([
      { sessionId: "s1", mintedCount: 3, hostCapability: "unknown" },
    ]);
    const session = sessionOf(store)!;
    expect(session.history.every((item) => Boolean(item.message.id))).toBe(
      true,
    );
    // A minted id is runtime-only: the load must not be recorded as persisted,
    // not look modified, and not claim the disk identity was migrated.
    expect(session.dirty).toBe(false);
    expect(session.historyRevision).toBe(0);
    expect(session.persistence).toBeUndefined();
    expect(session.messageIdMigration.state).not.toBe("succeeded");
    // An undeclared capability means the migration request is never sent at all
    // (an unknown messageType would hang on an old host).
    await vi.waitFor(() => {
      expect(selectMessageIdMigrationCapability(store.getState() as any)).toBe(
        "unsupported",
      );
    });
    expect(
      request.mock.calls.filter((call) => call[0] === "history/migrateIds"),
    ).toHaveLength(0);
  });

  it("says nothing when the disk response already carries ids", async () => {
    const store = diskStore();
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [diskItem("user", "hi", "u1"), diskItem("assistant", "yo", "a1")],
      firstTurnItems: [diskItem("user", "hi", "u1")],
      hasMore: false,
      total: 2,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };
    const reports = captureReports();

    await run(store, loadSessionRuntime({ sessionId: "s1" }));

    expect(reports).toEqual([]);
  });

  it("keeps a supported host's session usable when the response still has no ids", async () => {
    const store = diskStore("supported");
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [diskItem("user", "hi"), diskItem("assistant", "yo")],
      firstTurnItems: [],
      hasMore: false,
      total: 2,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };
    store.mockIdeMessenger.responses["history/migrateIds"] = {
      migrated: true,
      addedCount: 2,
    };
    const reports = captureReports();

    await run(store, loadSessionRuntime({ sessionId: "s1" }));

    // Recorded — but a declared capability only proves the host forwards
    // `history/migrateIds`; it is not a promise that load returns ids.
    expect(reports).toEqual([
      { sessionId: "s1", mintedCount: 2, hostCapability: "supported" },
    ]);
    const idsAfterLoad = sessionOf(store)!.history.map(
      (item) => item.message.id,
    );
    await vi.waitFor(() => {
      expect(sessionOf(store)!.messageIdMigration.state).toBe("succeeded");
    });
    // The migration rewrites the disk file; the runtime keeps showing the ids it
    // already handed to the UI.
    expect(sessionOf(store)!.history.map((item) => item.message.id)).toEqual(
      idsAfterLoad,
    );
    expect(sessionOf(store)!.historyRevision).toBe(0);
    expect(sessionOf(store)!.dirty).toBe(false);
  });

  it("reports loadMore and changes nothing else", async () => {
    const store = runtimeStore({
      contextMetrics: {
        didPrune: false,
        contextPercentage: 0.5,
        inputTokens: 1,
        contextLength: 2,
      },
      contextMetricsMeta: {
        modelIdentity: "",
        historyRevision: 0,
        schemaVersion: 1,
      },
    });
    const metrics = sessionOf(store)!.contextMetrics;
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [diskItem("user", "older-1"), diskItem("assistant", "older-2")],
      hasMore: false,
      total: 4,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };
    const reports = captureReports();

    await run(store, loadMoreHistory({ sessionId: "s1" }));

    expect(reports).toEqual([
      { sessionId: "s1", mintedCount: 2, hostCapability: "supported" },
    ]);
    const session = sessionOf(store)!;
    expect(session.history).toHaveLength(4);
    expect(session.history.every((item) => Boolean(item.message.id))).toBe(
      true,
    );
    // Diagnostics only: the fallback itself neither frees nor invalidates the
    // metrics snapshot, and never makes the session look user-modified.
    expect(session.contextMetrics).toBe(metrics);
    expect(session.dirty).toBe(false);
  });

  it("differs from a no-fallback load only by the minted ids", async () => {
    const METRICS = {
      didPrune: false,
      contextPercentage: 0.33,
      inputTokens: 7,
      contextLength: 21,
    };
    const META = { modelIdentity: "", historyRevision: 0, schemaVersion: 1 };

    // Two identical loads; the only difference is whether the disk page carried
    // ids. Everything else a fallback could plausibly disturb must match.
    async function loadMore(items: ChatHistoryItem[]) {
      const store = runtimeStore({
        contextMetrics: METRICS,
        contextMetricsMeta: META,
      });
      store.mockIdeMessenger.responses["history/loadPage"] = {
        items,
        hasMore: false,
        total: items.length + 2,
        session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
      };
      const before = sessionOf(store)!;
      const metricsBefore = before.contextMetrics;
      const persistenceBefore = before.persistence;
      await run(store, loadMoreHistory({ sessionId: "s1" }));
      const after = sessionOf(store)!;
      return { after, metricsBefore, persistenceBefore };
    }

    const minted = await loadMore([
      diskItem("user", "older-1"),
      diskItem("assistant", "older-2"),
    ]);
    const alreadyIdentified = await loadMore([
      diskItem("user", "older-1", "o1"),
      diskItem("assistant", "older-2", "o2"),
    ]);

    // `prependSessionHistory` bumps `historyRevision` by design; the point is
    // that minting adds nothing on top of it.
    expect(minted.after.historyRevision).toBe(
      alreadyIdentified.after.historyRevision,
    );
    expect(minted.after.dirty).toBe(alreadyIdentified.after.dirty);
    expect(minted.after.dirty).toBe(false);
    expect(minted.after.persistence).toBe(alreadyIdentified.after.persistence);
    expect(minted.after.persistence).toBe(minted.persistenceBefore);
    // The snapshot is neither freed nor replaced.
    expect(minted.after.contextMetrics).toBe(minted.metricsBefore);
    expect(minted.after.contextMetricsMeta).toBe(META);
    // The request-relevant content is identical; only the ids differ.
    expect(minted.after.history.map((item) => item.message.content)).toEqual(
      alreadyIdentified.after.history.map((item) => item.message.content),
    );
    expect(
      minted.after.history
        .slice(0, 2)
        .every((item) => Boolean(item.message.id) && item.message.id !== "o1"),
    ).toBe(true);
  });

  it("reports nothing for a loadMore page that already has ids", async () => {
    const store = runtimeStore();
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [
        diskItem("user", "older-1", "o1"),
        diskItem("assistant", "older-2", "o2"),
      ],
      hasMore: false,
      total: 4,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };
    const reports = captureReports();

    await run(store, loadMoreHistory({ sessionId: "s1" }));

    expect(reports).toEqual([]);
  });

  it("reports loadFull's minted frozen-head ids", async () => {
    const store = runtimeStore({
      pagination: {
        truncated: true,
        loadedOffset: 2,
        totalCount: 4,
        loadedDiskCount: 2,
        hasMore: true,
        loading: false,
        requestGeneration: 0,
        persistPending: false,
      },
    });
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "s1",
      title: "Chat 1",
      workspaceDirectory: "",
      // The frozen head carries no ids and is exactly what the window misses.
      history: [
        diskItem("user", "head-u"),
        diskItem("assistant", "head-a"),
        runtimeItem("u1", "user"),
        runtimeItem("a1", "assistant"),
      ],
    };
    const reports = captureReports();

    await run(store, loadFullHistory({ sessionId: "s1" }));

    expect(reports).toEqual([
      { sessionId: "s1", mintedCount: 2, hostCapability: "supported" },
    ]);
    expect(sessionOf(store)!.history.every((item) => item.message.id)).toBe(
      true,
    );
  });

  it("reports the first turn coming back from a save", async () => {
    const store = runtimeStore({
      dirty: true,
      persistence: {
        state: "pending",
        revision: 2,
        persistedRevision: 0,
        hasPersistedBaseline: false,
      },
    });
    store.mockIdeMessenger.responses["history/save"] = {
      firstTurnItems: [diskItem("user", "first")],
      totalHistoryCount: 2,
    };
    const reports = captureReports();

    await run(store, saveSession({ sessionId: "s1", reason: "test" }));

    expect(reports).toEqual([
      { sessionId: "s1", mintedCount: 1, hostCapability: "supported" },
    ]);
    expect(sessionOf(store)!.firstTurnItems).toHaveLength(1);
    expect(sessionOf(store)!.firstTurnItems[0].message.id).toBeTruthy();
  });

  it("does not resurrect a failed migration when the runtime had to mint", async () => {
    const store = runtimeStore({
      messageIdMigration: {
        state: "failed",
        code: "MESSAGE_ID_MIGRATION_FAILED",
        message: "write failed",
      },
    });
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [diskItem("user", "older")],
      hasMore: false,
      total: 3,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };
    const reports = captureReports();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, loadMoreHistory({ sessionId: "s1" }));

    // Both facts coexist: the runtime works, the disk identity did not migrate.
    expect(reports).toHaveLength(1);
    expect(sessionOf(store)!.messageIdMigration).toEqual({
      state: "failed",
      code: "MESSAGE_ID_MIGRATION_FAILED",
      message: "write failed",
    });
    expect(
      request.mock.calls.filter((call) => call[0] === "history/migrateIds"),
    ).toHaveLength(0);
  });

  it("does not mint into the migration state when the host is unsupported", async () => {
    const store = runtimeStore({}, "unknown");
    store.mockIdeMessenger.responses["history/loadPage"] = {
      items: [diskItem("user", "older")],
      hasMore: false,
      total: 3,
      session: { title: "Chat 1", workspaceDirectory: "", mode: "chat" },
    };
    const reports = captureReports();

    await run(store, loadMoreHistory({ sessionId: "s1" }));
    expect(reports).toHaveLength(1);

    await vi.waitFor(() => {
      expect(selectMessageIdMigrationCapability(store.getState() as any)).toBe(
        "unsupported",
      );
    });
    // Minting happened, yet nothing claims a completed migration.
    expect(sessionOf(store)!.messageIdMigration).toEqual({
      state: "unsupported",
    });
  });
});
