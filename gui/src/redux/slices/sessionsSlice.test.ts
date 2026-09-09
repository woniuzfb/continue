import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "./sessionHistory";
import {
  applySessionStreamUpdate,
  beginSessionStream,
  closeSessionTabTransaction,
  createSessionRuntime,
  deleteTurnByMessageId,
  initialSessionRuntime,
  initialSessionsState,
  markSessionPersisted,
  setActiveSessionId,
  setAppliedRulesByMessageId,
  setCompactionLoadingByMessageId,
  setSessionConversationSummary,
  setSessionTitle,
  trimSessionHistoryWindow,
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
        newEmptySession: initialSessionRuntime("s-new", "Chat 1"),
      }),
    );

    expect(state.tabOrder).toEqual(["s-new"]);
    expect(state.activeSessionId).toBe("s-new");
    expect(state.sessionsById["s-new"]).toBeDefined();
    expect(state.sessionsById.s1).toBeDefined();
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
