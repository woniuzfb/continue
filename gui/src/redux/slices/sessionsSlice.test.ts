import { describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "./sessionHistory";
import {
  applySessionStreamUpdate,
  beginSessionStream,
  clearSavedMergedReplyProvenance,
  closeSessionTabTransaction,
  createSessionRuntime,
  deleteCompactionByMessageId,
  deleteTurnByMessageId,
  initialSessionRuntime,
  initialSessionsState,
  markSessionDirty,
  markSessionPersisted,
  markSessionSaveFailed,
  setActiveSessionId,
  setAllSessionMergeSettings,
  setAppliedRulesByMessageId,
  setCompactionLoadingByMessageId,
  setSessionConversationSummary,
  setSessionTitle,
  trimSessionHistoryWindow,
  updateHistoryItemByMessageId,
  sessionsSlice,
} from "./sessionsSlice";
import {
  initialSessionCatalogState,
  removeSessionMetadata,
  sessionCatalogSlice,
  setLastSessionId,
  upsertSessionMetadata,
} from "./sessionCatalogSlice";

function item(
  id: string,
  role: "user" | "assistant",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function stateWith(overrides = {}) {
  const session = initialSessionRuntime("s1", "Chat 1", overrides);
  return sessionsSlice.reducer(
    initialSessionsState,
    createSessionRuntime({ session }),
  );
}

describe("sessionsSlice — ownership", () => {
  it("registers a runtime, descriptor and tab order entry", () => {
    const state = stateWith();
    expect(state.sessionsById.s1).toBeDefined();
    expect(state.tabOrder).toEqual(["s1"]);
    expect(state.tabDescriptors.s1).toEqual({
      sessionId: "s1",
      title: "Chat 1",
      loadState: "loaded",
      mode: "chat",
    });
  });

  it("closes a tab atomically and activates the right-hand neighbour", () => {
    let state = stateWith();
    state = sessionsSlice.reducer(
      state,
      createSessionRuntime({ session: initialSessionRuntime("s2", "Chat 2") }),
    );
    state = sessionsSlice.reducer(
      state,
      createSessionRuntime({ session: initialSessionRuntime("s3", "Chat 3") }),
    );
    state = sessionsSlice.reducer(
      state,
      setActiveSessionId({ sessionId: "s2" }),
    );

    state = sessionsSlice.reducer(
      state,
      closeSessionTabTransaction({
        sessionId: "s2",
        wasActive: true,
        replacementSessionId: "s3",
      }),
    );

    expect(state.tabOrder).toEqual(["s1", "s3"]);
    expect(state.tabDescriptors.s2).toBeUndefined();
    expect(state.activeSessionId).toBe("s3");
    // Runtime owner survives until the caller releases it (streaming/failed).
    expect(state.sessionsById.s2).toBeDefined();
  });

  it("creates and activates an empty session inside the close transaction", () => {
    let state = stateWith();
    state = sessionsSlice.reducer(
      state,
      closeSessionTabTransaction({
        sessionId: "s1",
        wasActive: true,
        newEmptySession: initialSessionRuntime("s-new", "Chat 1"),
      }),
    );

    expect(state.tabOrder).toEqual(["s-new"]);
    expect(state.activeSessionId).toBe("s-new");
    expect(state.sessionsById["s-new"]).toBeDefined();
    expect(state.sessionsById.s1).toBeDefined();
  });

  it("closing an inactive tab never moves the visible tab", () => {
    let state = stateWith();
    state = sessionsSlice.reducer(
      state,
      createSessionRuntime({ session: initialSessionRuntime("s2", "Chat 2") }),
    );
    state = sessionsSlice.reducer(
      state,
      createSessionRuntime({ session: initialSessionRuntime("s3", "Chat 3") }),
    );
    state = sessionsSlice.reducer(
      state,
      setActiveSessionId({ sessionId: "s1" }),
    );

    state = sessionsSlice.reducer(
      state,
      closeSessionTabTransaction({
        sessionId: "s2",
        wasActive: false,
        replacementSessionId: undefined,
        newEmptySession: undefined,
      }),
    );

    expect(state.tabOrder).toEqual(["s1", "s3"]);
    expect(state.tabDescriptors.s2).toBeUndefined();
    expect(state.activeSessionId).toBe("s1");
  });

  it("bumps the persistence revision on every content mutation", () => {
    // 方案.md §七.3/§七.6: the save queue and the stale-response guard compare
    // this counter, so a compact/delete/edit must move it, not only submit.
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    const before = state.sessionsById.s1.persistence?.revision ?? 0;

    state = sessionsSlice.reducer(
      state,
      updateHistoryItemByMessageId({
        sessionId: "s1",
        messageId: "u1",
        updates: { conversationSummary: "compacted" },
      }),
    );

    expect(state.sessionsById.s1.persistence?.revision).toBe(before + 1);
    expect(state.sessionsById.s1.persistence?.state).toBe("pending");
    expect(state.sessionsById.s1.dirty).toBe(true);
  });

  it("keeps a failed save visible when more content arrives", () => {
    // 方案.md §七.7: a failed save keeps state=failed, dirty and the error until
    // an explicit retry succeeds. New content must not silently turn it into
    // pending — that would hide the retry banner and re-enable the gates that
    // depend on `state === "failed"`.
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    state = sessionsSlice.reducer(
      state,
      markSessionSaveFailed({
        sessionId: "s1",
        error: { code: "SESSION_SAVE_FAILED", message: "disk full" },
      }),
    );
    const failed = state.sessionsById.s1.persistence!;
    expect(failed.state).toBe("failed");

    // A stream chunk / tool result / compact arrives.
    state = sessionsSlice.reducer(
      state,
      updateHistoryItemByMessageId({
        sessionId: "s1",
        messageId: "u1",
        updates: { conversationSummary: "compacted" },
      }),
    );
    expect(state.sessionsById.s1.persistence).toMatchObject({
      state: "failed",
      revision: failed.revision + 1,
    });
    expect(state.sessionsById.s1.persistence!.error?.message).toBe("disk full");
    expect(state.sessionsById.s1.dirty).toBe(true);

    // A plain dirty mark (model / title) must preserve it too.
    state = sessionsSlice.reducer(state, markSessionDirty({ sessionId: "s1" }));
    expect(state.sessionsById.s1.persistence).toMatchObject({
      state: "failed",
      revision: failed.revision + 2,
    });
    expect(state.sessionsById.s1.persistence!.error?.message).toBe("disk full");
  });

  it("keeps the runtime summary in sync with compact / delete", () => {
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    state = sessionsSlice.reducer(
      state,
      updateHistoryItemByMessageId({
        sessionId: "s1",
        messageId: "u1",
        updates: { conversationSummary: "compacted" },
      }),
    );
    expect(state.sessionsById.s1.latestConversationSummary).toEqual({
      sourceMessageId: "u1",
      sourceAbsoluteIndex: 0,
      content: "compacted",
    });

    state = sessionsSlice.reducer(
      state,
      deleteCompactionByMessageId({ sessionId: "s1", messageId: "u1" }),
    );
    expect(state.sessionsById.s1.latestConversationSummary).toBeUndefined();
  });

  it("keeps runtime title authoritative and syncs the descriptor", () => {
    let state = stateWith();
    state = sessionsSlice.reducer(
      state,
      setSessionTitle({ sessionId: "s1", title: "Renamed" }),
    );
    expect(state.sessionsById.s1.title).toBe("Renamed");
    expect(state.tabDescriptors.s1.title).toBe("Renamed");
  });

  it("leaves other sessions' references untouched", () => {
    let state = stateWith();
    const second = initialSessionRuntime("s2", "Chat 2");
    state = sessionsSlice.reducer(
      state,
      createSessionRuntime({ session: second }),
    );
    const before = state.sessionsById.s2;
    state = sessionsSlice.reducer(
      state,
      setSessionTitle({ sessionId: "s1", title: "Renamed" }),
    );
    expect(state.sessionsById.s2).toBe(before);
  });
});

describe("sessionsSlice — stream identity", () => {
  it("applies chunks only for the current requestId", () => {
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "stale",
        messages: [{ role: "assistant", content: "nope" }],
      }),
    );
    expect(state.sessionsById.s1.history).toHaveLength(1);

    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [{ role: "assistant", content: "hello" }],
      }),
    );
    expect(state.sessionsById.s1.history).toHaveLength(2);
    expect(state.sessionsById.s1.history[1].message.content).toBe("hello");
  });
});

describe("sessionsSlice — message identity", () => {
  it("writes applied rules by messageId, not by index", () => {
    let state = stateWith({
      history: [
        item("u1", "user", "a"),
        item("a1", "assistant", "b"),
        item("u2", "user", "c"),
      ],
    });
    state = sessionsSlice.reducer(
      state,
      setAppliedRulesByMessageId({
        sessionId: "s1",
        messageId: "u2",
        appliedRules: [{ name: "r" } as any],
      }),
    );
    expect(state.sessionsById.s1.history[2].appliedRules).toEqual([
      { name: "r" },
    ]);
    expect(state.sessionsById.s1.history[0].appliedRules).toBeUndefined();
  });

  it("deletes the whole turn that contains the message", () => {
    let state = stateWith({
      history: [
        item("u1", "user", "a"),
        item("a1", "assistant", "b"),
        item("u2", "user", "c"),
        item("a2", "assistant", "d"),
      ],
    });
    state = sessionsSlice.reducer(
      state,
      deleteTurnByMessageId({ sessionId: "s1", messageId: "a1" }),
    );
    expect(state.sessionsById.s1.history.map((i) => i.message.id)).toEqual([
      "u2",
      "a2",
    ]);
  });

  it("keeps compaction loading attached to the message after a prepend", () => {
    let state = stateWith({
      history: [item("u2", "user", "later")],
    });
    state = sessionsSlice.reducer(
      state,
      setCompactionLoadingByMessageId({
        sessionId: "s1",
        messageId: "u2",
        loading: true,
      }),
    );
    state = sessionsSlice.reducer(state, {
      type: "sessions/prependSessionHistory",
      payload: {
        sessionId: "s1",
        items: [item("u1", "user", "older")],
        hasMore: false,
        newLoadedOffset: 0,
        totalCount: 2,
      },
    } as any);
    expect(state.sessionsById.s1.compactionLoading).toEqual({ u2: true });
  });

  it("clears the summary by messageId", () => {
    let state = stateWith({ history: [item("u1", "user", "a")] });
    state = sessionsSlice.reducer(
      state,
      setSessionConversationSummary({
        sessionId: "s1",
        summary: { sourceMessageId: "u1", content: "sum" },
      }),
    );
    expect(state.sessionsById.s1.latestConversationSummary?.content).toBe(
      "sum",
    );
    state = sessionsSlice.reducer(state, {
      type: "sessions/deleteCompactionByMessageId",
      payload: { sessionId: "s1", messageId: "u1" },
    } as any);
    expect(
      state.sessionsById.s1.history[0].conversationSummary,
    ).toBeUndefined();
  });
});

describe("sessionsSlice — trim bookkeeping", () => {
  it("atomically rebuilds every pagination field", () => {
    let state = stateWith({
      history: [
        item("u1", "user", "1"),
        item("a1", "assistant", "2"),
        item("u2", "user", "3"),
        item("a2", "assistant", "4"),
        item("u3", "user", "5"),
        item("a3", "assistant", "6"),
      ],
      dirty: true,
      pagination: {
        truncated: false,
        loadedOffset: 0,
        totalCount: 6,
        loadedDiskCount: 6,
        hasMore: false,
        loading: false,
        requestGeneration: 0,
        persistPending: false,
      },
    });
    // Caller keeps a whole turn (u3 + a3) and reports the exact disk mapping.
    state = sessionsSlice.reducer(
      state,
      trimSessionHistoryWindow({
        sessionId: "s1",
        keepCount: 2,
        removedDiskItems: 4,
        fullDiskItemCount: 6,
        retainedDiskItemCount: 2,
      }),
    );
    const { pagination, history } = state.sessionsById.s1;
    expect(history.map((i) => i.message.id)).toEqual(["u3", "a3"]);
    expect(pagination).toEqual({
      truncated: true,
      loadedOffset: 4,
      totalCount: 6,
      loadedDiskCount: 2,
      hasMore: true,
      loading: false,
      requestGeneration: 1,
      persistPending: true,
    });
  });
});

describe("sessionsSlice — persistence", () => {
  it("only clears dirty when the persisted revision catches up", () => {
    let state = stateWith({
      dirty: true,
      persistence: {
        state: "pending",
        revision: 3,
        persistedRevision: 0,
        hasPersistedBaseline: false,
      },
      pagination: {
        truncated: false,
        loadedOffset: 0,
        hasMore: false,
        loading: false,
        requestGeneration: 0,
        persistPending: true,
      },
    });
    state = sessionsSlice.reducer(
      state,
      markSessionPersisted({
        sessionId: "s1",
        revision: 2,
        hasPersistedBaseline: true,
      }),
    );
    expect(state.sessionsById.s1.persistence?.state).toBe("pending");
    expect(state.sessionsById.s1.dirty).toBe(true);

    state = sessionsSlice.reducer(
      state,
      markSessionPersisted({ sessionId: "s1", revision: 3 }),
    );
    expect(state.sessionsById.s1.persistence?.state).toBe("clean");
    expect(state.sessionsById.s1.dirty).toBe(false);
    expect(state.sessionsById.s1.pagination.persistPending).toBe(false);
  });
});

describe("sessionCatalogSlice", () => {
  it("upserts, removes and keeps lastSessionId in sync", () => {
    let state = sessionCatalogSlice.reducer(
      initialSessionCatalogState,
      upsertSessionMetadata({
        metadata: {
          sessionId: "s1",
          title: "One",
          dateCreated: "2026-01-01",
          workspaceDirectory: "ws",
        },
      }),
    );
    state = sessionCatalogSlice.reducer(
      state,
      setLastSessionId({ lastSessionId: "s1" }),
    );
    expect(state.allSessionMetadata).toHaveLength(1);
    expect(state.lastSessionId).toBe("s1");

    state = sessionCatalogSlice.reducer(
      state,
      upsertSessionMetadata({
        metadata: {
          sessionId: "s1",
          title: "One renamed",
          dateCreated: "2026-01-01",
          workspaceDirectory: "ws",
        },
      }),
    );
    expect(state.allSessionMetadata).toHaveLength(1);
    expect(state.allSessionMetadata[0].title).toBe("One renamed");

    state = sessionCatalogSlice.reducer(
      state,
      removeSessionMetadata({ sessionId: "s1" }),
    );
    expect(state.allSessionMetadata).toHaveLength(0);
    expect(state.lastSessionId).toBeUndefined();
  });
});

describe("clearSavedMergedReplyProvenance", () => {
  function merged(
    id: string,
    sourceMessageIds: string[],
  ): ChatHistoryItemWithMessageId {
    return {
      ...item(id, "assistant", "body"),
      mergedReplyProvenance: {
        sourceMessageIds,
        firstSourceMessageId: sourceMessageIds[0],
        lastSourceMessageId: sourceMessageIds[sourceMessageIds.length - 1],
      },
    };
  }

  function provenanceState() {
    const session = initialSessionRuntime("s1", "Chat 1", {
      history: [item("u1", "user", "hi"), merged("a1", ["a1", "a2"])],
      dirty: true,
      persistence: {
        state: "pending",
        revision: 5,
        persistedRevision: 4,
        hasPersistedBaseline: true,
      },
    });
    return {
      session,
      state: {
        ...initialSessionsState,
        activeSessionId: "s1",
        tabOrder: ["s1"],
        sessionsById: { s1: session },
      } as any,
    };
  }

  const fingerprint = {
    mergedItemMessageId: "a1",
    sourceMessageIds: ["a1", "a2"],
  };

  it("drops the provenance without looking like a mutation", () => {
    const { state } = provenanceState();
    const before = state.sessionsById.s1.history;

    const next = sessionsSlice.reducer(
      state,
      clearSavedMergedReplyProvenance({
        sessionId: "s1",
        savedMergedProvenance: [fingerprint],
      }),
    );
    const session = next.sessionsById.s1;

    expect(session.history[1].mergedReplyProvenance).toBeUndefined();
    expect(session.history[1].message.id).toBe("a1");
    // A new array is only justified because something was actually dropped.
    expect(session.history).not.toBe(before);
    // Pure: no dirty, no revision, no historyRevision — otherwise a save would
    // schedule another save (or invalidate the request-history cache) for free.
    expect(session.dirty).toBe(true);
    expect(session.persistence).toMatchObject({
      state: "pending",
      revision: 5,
    });
    expect(session.historyRevision).toBe(state.sessionsById.s1.historyRevision);
  });

  it("keeps the array reference when no fingerprint matches", () => {
    const { state } = provenanceState();
    const before = state.sessionsById.s1.history;

    const next = sessionsSlice.reducer(
      state,
      clearSavedMergedReplyProvenance({
        sessionId: "s1",
        savedMergedProvenance: [
          { mergedItemMessageId: "a1", sourceMessageIds: ["a1"] },
        ],
      }),
    );

    expect(next.sessionsById.s1.history).toBe(before);
    expect(
      next.sessionsById.s1.history[1].mergedReplyProvenance?.sourceMessageIds,
    ).toEqual(["a1", "a2"]);
  });
});

// ── C3: merge settings projection (方案.md §五.17) ────────────────────────

describe("sessionsSlice — merge settings projection", () => {
  /** s1 active + dirty, s2 hidden + dirty, both carrying a stale `true` mirror. */
  function twoRuntimes() {
    let state = sessionsSlice.reducer(
      initialSessionsState,
      createSessionRuntime({
        session: initialSessionRuntime("s1", "One", {
          dontMergeReplyBubbles: true,
          dontMergeHistoricalReplyBubbles: true,
          dirty: true,
          persistence: {
            state: "pending",
            revision: 3,
            persistedRevision: 2,
            hasPersistedBaseline: true,
          },
        }),
      }),
    );
    state = sessionsSlice.reducer(
      state,
      createSessionRuntime({
        session: initialSessionRuntime("s2", "Two", {
          dontMergeReplyBubbles: true,
          dontMergeHistoricalReplyBubbles: true,
          dirty: true,
          persistence: {
            state: "pending",
            revision: 5,
            persistedRevision: 4,
            hasPersistedBaseline: true,
          },
        }),
      }),
    );
    return sessionsSlice.reducer(
      state,
      setActiveSessionId({ sessionId: "s1" }),
    );
  }

  it("projects the new value onto every loaded runtime, not only the active one", () => {
    // D1: the old shell effect only rewrote the runtime that happened to be
    // active, so a hidden session kept the previous value — two truths for one
    // global switch.
    const state = twoRuntimes();

    const next = sessionsSlice.reducer(
      state,
      setAllSessionMergeSettings({
        dontMergeReplyBubbles: false,
        dontMergeHistoricalReplyBubbles: false,
      }),
    );

    expect(next.sessionsById.s1.dontMergeReplyBubbles).toBe(false);
    expect(next.sessionsById.s1.dontMergeHistoricalReplyBubbles).toBe(false);
    // The hidden runtime must not be skipped.
    expect(next.sessionsById.s2.dontMergeReplyBubbles).toBe(false);
    expect(next.sessionsById.s2.dontMergeHistoricalReplyBubbles).toBe(false);
  });

  it("is a pure runtime write: no dirty, no revision bump, no tab change", () => {
    const state = twoRuntimes();

    const next = sessionsSlice.reducer(
      state,
      setAllSessionMergeSettings({ dontMergeReplyBubbles: false }),
    );

    expect(next.activeSessionId).toBe("s1");
    expect(next.tabOrder).toEqual(state.tabOrder);
    expect(next.tabDescriptors).toEqual(state.tabDescriptors);
    for (const id of ["s1", "s2"]) {
      expect(next.sessionsById[id].dirty).toBe(true);
      expect(next.sessionsById[id].historyRevision).toBe(
        state.sessionsById[id].historyRevision,
      );
      expect(next.sessionsById[id].persistence).toEqual(
        state.sessionsById[id].persistence,
      );
    }
    // Only the field present in the payload is written.
    expect(next.sessionsById.s1.dontMergeHistoricalReplyBubbles).toBe(true);
    expect(next.sessionsById.s2.dontMergeHistoricalReplyBubbles).toBe(true);
  });

  it("never enqueues a save and leaves the visible tab untouched", () => {
    // The projection is a config mirror, not a persistence boundary (方案.md
    // §五.17): it must not look like a content mutation to any consumer.
    const store = createMockStore({ sessions: twoRuntimes() as any });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    store.dispatch(
      setAllSessionMergeSettings({
        dontMergeReplyBubbles: false,
        dontMergeHistoricalReplyBubbles: false,
      }),
    );

    expect(request).not.toHaveBeenCalledWith("history/save", expect.anything());
    const sessions = (store.getState() as any).sessions;
    expect(sessions.activeSessionId).toBe("s1");
    expect(sessions.sessionsById.s2.dontMergeReplyBubbles).toBe(false);
  });
});
