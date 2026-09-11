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
  finishSessionStream,
  commitSessionConversationTurn,
  initialSessionRuntime,
  initialSessionsState,
  markSessionDirty,
  markSessionPersisted,
  markSessionSaveFailed,
  pauseSessionStream,
  setActiveSessionId,
  setAllSessionMergeSettings,
  setAppliedRulesByMessageId,
  setCompactionLoadingByMessageId,
  setSessionConversationSummary,
  clearSessionConversationSummary,
  setSessionHistory,
  commitSubmittedTurn,
  setSessionFullConversationMetrics,
  beginSessionFullConversationMetricsMeasure,
  endSessionFullConversationMetricsMeasure,
  setSessionFirstTurn,
  setSessionMode,
  prependSessionHistory,
  setSessionStreamError,
  setSessionTitle,
  trimSessionHistoryWindow,
  truncateHistoryAfterMessageId,
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

/** 方案.md §五.16.6: the construction-environment stamp a caller validated. */
function envStamp() {
  return {
    rules: [],
    tools: [],
    experimental: undefined,
    skipBaseSystemMessage: false,
    modelsByRole: [],
    selectedModelByRole: undefined,
    toolSettings: {},
    toolGroupSettings: {},
    ruleSettings: {},
    chatModelTitle: "gpt-4o",
    mode: "chat" as const,
    hasReasoningEnabled: undefined,
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

  it("keeps the context metrics across promptLog / reasoning bookkeeping", () => {
    // 方案.md §五.16: a reply finishing attaches promptLogs + reasoning through
    // this reducer. That must be saved, but it must NOT invalidate the metrics
    // snapshot — otherwise the ring drops to zero the moment a reply finishes.
    const metrics = {
      inputTokens: 199149,
      contextLength: 200000,
      availableTokens: 851,
      contextPercentage: 0.42,
      exceedsContext: false,
    };
    let state = stateWith({
      history: [item("u1", "user", "hi")],
      fullConversationMetrics: metrics,
      fullConversationMetricsMeta: {
        constructionIdentity: "gpt-4o",
        conversationRevision: 0,
        schemaVersion: 1,
      },
      fullConversationMetricsEnvironment: envStamp(),
    });
    const revisionBefore = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      updateHistoryItemByMessageId({
        sessionId: "s1",
        messageId: "u1",
        updates: { promptLogs: [] },
      }),
    );

    expect(state.sessionsById.s1.fullConversationMetrics).toBe(metrics);
    // Bookkeeping does not invalidate freshness: the environment stamp survives.
    expect(state.sessionsById.s1.fullConversationMetricsEnvironment).toEqual(
      envStamp(),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(revisionBefore);
    // Still must be re-saved.
    expect(state.sessionsById.s1.dirty).toBe(true);
    expect(state.sessionsById.s1.persistence?.state).toBe("pending");

    // A real content update still invalidates the snapshot.
    state = sessionsSlice.reducer(
      state,
      updateHistoryItemByMessageId({
        sessionId: "s1",
        messageId: "u1",
        updates: { message: item("u1", "user", "edited").message },
      }),
    );
    expect(state.sessionsById.s1.fullConversationMetrics).toBe(metrics);
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBeUndefined();
    expect(state.sessionsById.s1.conversationRevision).toBe(revisionBefore + 1);
  });

  it("does not advance the conversation revision on a stream chunk", () => {
    // 方案.md §五.16.2: a chunk changes what must be saved, but the terminal
    // commit is what advances the conversation revision once.
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const revisionBefore = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [{ role: "assistant", content: "hi" } as any],
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(revisionBefore);
    expect(state.sessionsById.s1.dirty).toBe(true);
  });

  it("advances the conversation revision exactly once at a completed terminal", () => {
    const metrics = {
      inputTokens: 10,
      contextLength: 100,
      availableTokens: 90,
      contextPercentage: 0.3,
      exceedsContext: false,
    };
    let state = stateWith({
      history: [item("u1", "user", "hi")],
      fullConversationMetrics: metrics,
      fullConversationMetricsMeta: {
        constructionIdentity: "gpt-4o",
        conversationRevision: 0,
        schemaVersion: 1,
      },
      contextPercentage: 0.3,
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [{ role: "assistant", content: "a" } as any],
      }),
    );
    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [{ role: "assistant", content: "b" } as any],
      }),
    );
    // Chunks never advance the conversation revision.
    expect(state.sessionsById.s1.conversationRevision).toBe(before);

    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r1",
        terminalStatus: "completed",
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
    // Last-known value kept visible; only the freshness identity is cleared.
    expect(state.sessionsById.s1.fullConversationMetrics).toBe(metrics);
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBeUndefined();
    // …and with the identity gone, the environment stamp is meaningless: dropped
    // together with it so freshness can never be claimed from half state.
    expect(
      state.sessionsById.s1.fullConversationMetricsEnvironment,
    ).toBeUndefined();

    // A stale terminal (a different live request) is a no-op.
    const after = state.sessionsById.s1.conversationRevision;
    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r2",
        terminalStatus: "completed",
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(after);
  });

  it("advances the conversation revision once for aborted and failed terminals", () => {
    for (const status of ["aborted", "failed"] as const) {
      let state = stateWith({ history: [item("u1", "user", "hi")] });
      state = sessionsSlice.reducer(
        state,
        beginSessionStream({ sessionId: "s1", requestId: "r1" }),
      );
      const before = state.sessionsById.s1.conversationRevision;
      // The turn wrote content before it was stopped / failed: it is a real
      // logical turn, so its terminal commits it.
      state = sessionsSlice.reducer(
        state,
        applySessionStreamUpdate({
          sessionId: "s1",
          requestId: "r1",
          messages: [{ role: "assistant", content: "partial" } as any],
        }),
      );
      state = sessionsSlice.reducer(
        state,
        commitSessionConversationTurn({
          sessionId: "s1",
          requestId: "r1",
          terminalStatus: status,
        }),
      );
      expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
    }
  });

  it("does not commit a terminal that wrote no conversation content", () => {
    // 方案.md §五.16.4 step 2: out-of-context compile, stop or failure before the
    // first token, no model selected. The user's submit already advanced the
    // revision; a terminal for a turn that formed no output must not advance it
    // again, nor may it drop the metrics freshness identity.
    for (const status of ["completed", "aborted", "failed"] as const) {
      const meta = {
        constructionIdentity: "gpt-4o",
        conversationRevision: 0,
        schemaVersion: 1,
      };
      let state = stateWith({
        history: [item("u1", "user", "hi")],
        fullConversationMetrics: {
          inputTokens: 0,
          contextLength: 0,
          availableTokens: 0,
          contextPercentage: 0.2,
          exceedsContext: false,
        },
        fullConversationMetricsMeta: meta,
      });
      state = sessionsSlice.reducer(
        state,
        beginSessionStream({ sessionId: "s1", requestId: "r1" }),
      );
      const before = state.sessionsById.s1.conversationRevision;

      state = sessionsSlice.reducer(
        state,
        commitSessionConversationTurn({
          sessionId: "s1",
          requestId: "r1",
          terminalStatus: status,
        }),
      );

      expect(state.sessionsById.s1.conversationRevision).toBe(before);
      expect(state.sessionsById.s1.fullConversationMetricsMeta).toBe(meta);
    }
  });

  it("does not arm the terminal commit from a compile-metadata-only chunk", () => {
    const meta = {
      constructionIdentity: "gpt-4o",
      conversationRevision: 0,
      schemaVersion: 1,
    };
    const seeded = {
      inputTokens: 0,
      contextLength: 0,
      availableTokens: 0,
      contextPercentage: 0.2,
      exceedsContext: false,
    };
    let state = stateWith({
      history: [item("u1", "user", "hi")],
      fullConversationMetrics: seeded,
      fullConversationMetricsMeta: meta,
      fullConversationMetricsEnvironment: envStamp(),
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [
          {
            role: "assistant",
            content: "",
            metadata: { didPrune: true, contextPercentage: 0.5 },
          } as any,
        ],
      }),
    );
    // The prune metadata is history payload, not conversation content: the
    // snapshot keeps its last-known value AND its freshness identity. (The legacy
    // `isPruned` projection that used to mirror the chunk is gone in Stage 2E —
    // `exceedsContext` now only ever comes from a real measurement.)
    expect(state.sessionsById.s1.fullConversationMetrics).toBe(seeded);
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBe(meta);

    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r1",
        terminalStatus: "completed",
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBe(meta);
  });

  it("does not arm the terminal commit from a frame that writes nothing", () => {
    // 方案.md §五.16.4 step 2 must mean "this frame actually wrote conversation
    // content", not "this frame is not a compile-metadata frame". These frames
    // write nothing into an empty assistant placeholder:
    //   · Anthropic ends every stream with `{role:"assistant", content:"", usage}`
    //     (`core/llm/llms/Anthropic.ts`), a field this helper does not store;
    //   · a whitespace-only frame is dropped by the append guard.
    const frames = [
      { role: "assistant", content: "" },
      { role: "assistant", content: "", usage: { prompt_tokens: 1 } },
      { role: "assistant", content: "   " },
    ] as any[];

    for (const frame of frames) {
      const meta = {
        constructionIdentity: "gpt-4o",
        conversationRevision: 0,
        schemaVersion: 1,
      };
      let state = stateWith({
        history: [item("u1", "user", "hi"), item("p1", "assistant", "")],
        fullConversationMetrics: {
          inputTokens: 0,
          contextLength: 0,
          availableTokens: 0,
          contextPercentage: 0.2,
          exceedsContext: false,
        },
        fullConversationMetricsMeta: meta,
      });
      state = sessionsSlice.reducer(
        state,
        beginSessionStream({ sessionId: "s1", requestId: "r1" }),
      );
      const before = state.sessionsById.s1.conversationRevision;

      state = sessionsSlice.reducer(
        state,
        applySessionStreamUpdate({
          sessionId: "s1",
          requestId: "r1",
          messages: [frame],
        }),
      );

      expect(state.sessionsById.s1.stream.hasConversationMutation).toBeFalsy();

      state = sessionsSlice.reducer(
        state,
        commitSessionConversationTurn({
          sessionId: "s1",
          requestId: "r1",
          terminalStatus: "completed",
        }),
      );
      expect(state.sessionsById.s1.conversationRevision).toBe(before);
      expect(state.sessionsById.s1.fullConversationMetricsMeta).toBe(meta);
    }

    // A thinking frame with neither signature nor reasoning details, landing on
    // an existing thinking item, also writes nothing.
    let state = stateWith({
      history: [
        item("u1", "user", "hi"),
        {
          message: { id: "t1", role: "thinking", content: "" } as any,
          contextItems: [],
        },
      ],
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const before = state.sessionsById.s1.conversationRevision;
    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [{ role: "thinking", content: "" } as any],
      }),
    );
    expect(state.sessionsById.s1.stream.hasConversationMutation).toBeFalsy();
    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r1",
        terminalStatus: "completed",
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before);
  });

  it("arms when a batch mixes metadata and empty frames with real content", () => {
    let state = stateWith({
      history: [item("u1", "user", "hi"), item("p1", "assistant", "")],
      fullConversationMetrics: {
        inputTokens: 0,
        contextLength: 0,
        availableTokens: 0,
        contextPercentage: 0.2,
        exceedsContext: false,
      },
      fullConversationMetricsMeta: {
        constructionIdentity: "gpt-4o",
        conversationRevision: 0,
        schemaVersion: 1,
      },
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [
          {
            role: "assistant",
            content: "",
            metadata: { didPrune: true, contextPercentage: 0.5 },
          },
          { role: "assistant", content: "" },
          { role: "assistant", content: "real answer" },
        ] as any[],
      }),
    );

    expect(state.sessionsById.s1.stream.hasConversationMutation).toBe(true);

    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r1",
        terminalStatus: "completed",
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
  });

  it("arms the turn from a new history item even when it starts empty", () => {
    // A tool result is appended as a new history item through
    // applySessionStreamUpdate; an empty-output tool still produced that item,
    // so the turn must commit (方案.md §五.16.1: tool result 进入完整逻辑会话).
    let state = stateWith({
      history: [item("u1", "user", "hi"), item("a1", "assistant", "")],
      fullConversationMetrics: {
        inputTokens: 0,
        contextLength: 0,
        availableTokens: 0,
        contextPercentage: 0.2,
        exceedsContext: false,
      },
      fullConversationMetricsMeta: {
        constructionIdentity: "gpt-4o",
        conversationRevision: 0,
        schemaVersion: 1,
      },
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [{ role: "tool", content: "", toolCallId: "t1" } as any],
      }),
    );

    expect(state.sessionsById.s1.history).toHaveLength(3);
    expect(state.sessionsById.s1.stream.hasConversationMutation).toBe(true);

    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r1",
        terminalStatus: "completed",
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
  });

  it("keeps the arming across the tool loop's continuation request", () => {
    // The tool loop starts its next model request while the predecessor is still
    // live; that continuation's terminal is the one that commits the turn.
    let state = stateWith({
      history: [item("u1", "user", "hi")],
      fullConversationMetrics: {
        inputTokens: 0,
        contextLength: 0,
        availableTokens: 0,
        contextPercentage: 0.2,
        exceedsContext: false,
      },
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [{ role: "assistant", content: "call" } as any],
      }),
    );
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r2" }),
    );

    expect(state.sessionsById.s1.stream.hasConversationMutation).toBe(true);
    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r2",
        terminalStatus: "completed",
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBeUndefined();
  });

  it("starts a new turn without the previous turn's arming", () => {
    let state = stateWith({
      history: [item("u1", "user", "hi")],
      fullConversationMetrics: {
        inputTokens: 0,
        contextLength: 0,
        availableTokens: 0,
        contextPercentage: 0.2,
        exceedsContext: false,
      },
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    state = sessionsSlice.reducer(
      state,
      applySessionStreamUpdate({
        sessionId: "s1",
        requestId: "r1",
        messages: [{ role: "assistant", content: "reply" } as any],
      }),
    );
    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r1",
        terminalStatus: "completed",
      }),
    );
    state = sessionsSlice.reducer(
      state,
      finishSessionStream({
        sessionId: "s1",
        requestId: "r1",
        status: "completed",
      }),
    );
    const meta = state.sessionsById.s1.fullConversationMetricsMeta;
    const before = state.sessionsById.s1.conversationRevision;

    // The next turn fails before its first token.
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r2" }),
    );
    expect(state.sessionsById.s1.stream.hasConversationMutation).toBe(false);
    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r2",
        terminalStatus: "failed",
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBe(meta);
  });

  it("keeps the arming across pause and stream error", () => {
    // Awaiting-approval and waiting-for-apply are `idle` with a live request,
    // and a failed stream may still have written partial output. Both keep the
    // turn's arming so the terminal commits it.
    for (const kind of ["pause", "error"] as const) {
      let state = stateWith({ history: [item("u1", "user", "hi")] });
      state = sessionsSlice.reducer(
        state,
        beginSessionStream({ sessionId: "s1", requestId: "r1" }),
      );
      state = sessionsSlice.reducer(
        state,
        applySessionStreamUpdate({
          sessionId: "s1",
          requestId: "r1",
          messages: [{ role: "assistant", content: "partial" } as any],
        }),
      );
      const before = state.sessionsById.s1.conversationRevision;

      state = sessionsSlice.reducer(
        state,
        kind === "pause"
          ? pauseSessionStream({ sessionId: "s1", requestId: "r1" })
          : setSessionStreamError({
              sessionId: "s1",
              requestId: "r1",
              error: "boom",
            }),
      );
      expect(state.sessionsById.s1.stream.hasConversationMutation).toBe(true);

      state = sessionsSlice.reducer(
        state,
        commitSessionConversationTurn({
          sessionId: "s1",
          requestId: "r1",
          terminalStatus: kind === "pause" ? "aborted" : "failed",
        }),
      );
      expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
    }
  });

  it("advances the conversation revision once for a tool continuation turn", () => {
    // 方案.md §五.16.4: the terminal commit is the ONLY conversation-revision
    // boundary inside a live turn. Tool call / tool result writes reach history
    // through updateHistoryItemByMessageId, so they must only mark the content
    // for saving and arm that commit — bumping here too would count the same
    // logical change twice.
    let state = stateWith({ history: [item("a1", "assistant", "")] });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const before = state.sessionsById.s1.conversationRevision;
    const persistenceBefore = state.sessionsById.s1.persistence?.revision ?? 0;

    state = sessionsSlice.reducer(
      state,
      updateHistoryItemByMessageId({
        sessionId: "s1",
        messageId: "a1",
        updates: {
          toolCallStates: [{ toolCallId: "t1", status: "done" } as any],
        },
      }),
    );

    // Still must be saved, but it is not yet a new conversation version.
    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    expect(state.sessionsById.s1.persistence?.revision).toBe(
      persistenceBefore + 1,
    );
    expect(state.sessionsById.s1.stream.hasConversationMutation).toBe(true);

    // Awaiting approval, then the continuation request that owns the terminal.
    state = sessionsSlice.reducer(
      state,
      pauseSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r2" }),
    );
    expect(state.sessionsById.s1.stream.hasConversationMutation).toBe(true);

    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "r2",
        terminalStatus: "completed",
      }),
    );

    // Exactly one revision for the whole logical turn, tool writes included.
    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
  });

  it("advances the conversation revision immediately for an out-of-stream mutation", () => {
    // No live request: an edit / compact / delete is a complete content version
    // by itself, so there is no terminal that could commit it later.
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      updateHistoryItemByMessageId({
        sessionId: "s1",
        messageId: "u1",
        updates: { message: item("u1", "user", "edited").message },
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
  });

  it("keeps the last-known metrics values when a mutation makes them stale", () => {
    // 方案.md §五.16: a stale snapshot keeps its last-known VALUE (the ring does
    // not blank); only the freshness identity is dropped. This holds for an
    // out-of-stream mutation and for a write inside a live turn.
    for (const live of [false, true]) {
      const metrics = {
        inputTokens: 10,
        contextLength: 100,
        availableTokens: 90,
        contextPercentage: 0.33,
        exceedsContext: false,
      };
      let state = stateWith({
        history: [item("a1", "assistant", "")],
        fullConversationMetrics: metrics,
        fullConversationMetricsMeta: {
          constructionIdentity: "gpt-4o",
          conversationRevision: 0,
          schemaVersion: 1,
        },
      });
      if (live) {
        state = sessionsSlice.reducer(
          state,
          beginSessionStream({ sessionId: "s1", requestId: "r1" }),
        );
      }

      state = sessionsSlice.reducer(
        state,
        updateHistoryItemByMessageId({
          sessionId: "s1",
          messageId: "a1",
          updates: {
            toolCallStates: [{ toolCallId: "t1", status: "done" } as any],
          },
        }),
      );

      expect(state.sessionsById.s1.fullConversationMetrics).toBe(metrics);
      expect(state.sessionsById.s1.fullConversationMetricsMeta).toBeUndefined();
      expect(
        state.sessionsById.s1.fullConversationMetricsEnvironment,
      ).toBeUndefined();
    }
  });

  it("does not arm from a bookkeeping-only update", () => {
    // appliedRules / promptLogs / reasoning are saved but are not conversation
    // content, so a turn that only wrote them has nothing to commit.
    for (const updates of [
      { appliedRules: [] },
      { promptLogs: [] },
    ] as Partial<ChatHistoryItemWithMessageId>[]) {
      let state = stateWith({ history: [item("a1", "assistant", "")] });
      state = sessionsSlice.reducer(
        state,
        beginSessionStream({ sessionId: "s1", requestId: "r1" }),
      );
      state = sessionsSlice.reducer(
        state,
        updateHistoryItemByMessageId({
          sessionId: "s1",
          messageId: "a1",
          updates,
        }),
      );
      const before = state.sessionsById.s1.conversationRevision;

      state = sessionsSlice.reducer(
        state,
        commitSessionConversationTurn({
          sessionId: "s1",
          requestId: "r1",
          terminalStatus: "completed",
        }),
      );

      expect(state.sessionsById.s1.conversationRevision).toBe(before);
    }
  });

  it("does not advance the conversation revision for a stale terminal", () => {
    const meta = {
      constructionIdentity: "gpt-4o",
      conversationRevision: 0,
      schemaVersion: 1,
    };
    let state = stateWith({
      history: [item("u1", "user", "hi")],
      fullConversationMetrics: {
        inputTokens: 0,
        contextLength: 0,
        availableTokens: 0,
        contextPercentage: 0.2,
        exceedsContext: false,
      },
      fullConversationMetricsMeta: meta,
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      commitSessionConversationTurn({
        sessionId: "s1",
        requestId: "other",
        terminalStatus: "completed",
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBe(meta);
  });

  it("ends a non-chat stream without committing the conversation", () => {
    // Edit mode's diff stream ends through finishSessionStream alone; it must
    // not advance the conversation revision or clear the metrics freshness.
    const meta = {
      constructionIdentity: "gpt-4o",
      conversationRevision: 0,
      schemaVersion: 1,
    };
    let state = stateWith({
      history: [item("u1", "user", "hi")],
      fullConversationMetrics: {
        inputTokens: 0,
        contextLength: 0,
        availableTokens: 0,
        contextPercentage: 0.2,
        exceedsContext: false,
      },
      fullConversationMetricsMeta: meta,
    });
    state = sessionsSlice.reducer(
      state,
      beginSessionStream({ sessionId: "s1", requestId: "r1" }),
    );
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      finishSessionStream({
        sessionId: "s1",
        requestId: "r1",
        status: "completed",
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBe(meta);
  });

  it("treats appliedRules as bookkeeping, not a conversation change", () => {
    const metrics = {
      inputTokens: 0,
      contextLength: 0,
      availableTokens: 0,
      contextPercentage: 0.3,
      exceedsContext: false,
    };
    let state = stateWith({
      history: [item("u1", "user", "hi")],
      fullConversationMetrics: metrics,
      fullConversationMetricsMeta: {
        constructionIdentity: "gpt-4o",
        conversationRevision: 0,
        schemaVersion: 1,
      },
    });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setAppliedRulesByMessageId({
        sessionId: "s1",
        messageId: "u1",
        appliedRules: [{ name: "r" } as any],
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    expect(state.sessionsById.s1.fullConversationMetrics).toBe(metrics);
    expect(state.sessionsById.s1.dirty).toBe(true);
    expect(state.sessionsById.s1.persistence?.revision).toBeGreaterThan(0);
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

describe("sessionsSlice — save-echo bookkeeping", () => {
  // A successful save echoes the disk first turn and summary back into the
  // runtime (方案.md §七.8.1). Neither is a new version of the conversation
  // content, so the echo must not advance the revision (方案.md §五.16.1) —
  // otherwise every save makes the metrics snapshot look stale and drops an
  // in-flight metrics compile.
  it("does not advance the revision when a save echoes the same first turn", () => {
    let state = stateWith({
      history: [item("u1", "user", "a")],
      firstTurnItems: [item("u1", "user", "a")],
    });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setSessionFirstTurn({
        sessionId: "s1",
        firstTurnItems: [item("u1", "user", "a")],
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    // The response still replaced the value (it is the authority for content).
    expect(state.sessionsById.s1.firstTurnItems).toHaveLength(1);
  });

  it("never advances the revision from a first-turn write, even a real change", () => {
    // 方案.md §五.16.1 / 已知限制 #64: `firstTurnItems` is a derived cache of the
    // disk head that only feeds the Local Provider's reduced send payload; the
    // full-conversation metrics are built from the full history, so hydration and
    // save echo never own the content revision.
    let state = stateWith({
      history: [item("u1", "user", "a")],
      firstTurnItems: [item("u1", "user", "a")],
    });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setSessionFirstTurn({
        sessionId: "s1",
        firstTurnItems: [item("u9", "user", "a")],
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    // The response is still the authority for the value itself.
    expect(state.sessionsById.s1.firstTurnItems[0].message.id).toBe("u9");
  });

  it("does not advance the revision or churn the reference for an equal summary", () => {
    const summary = { sourceMessageId: "u1", content: "sum" };
    let state = stateWith({
      history: [item("u1", "user", "a")],
      latestConversationSummary: summary,
    });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setSessionConversationSummary({
        sessionId: "s1",
        summary: { sourceMessageId: "u1", content: "sum" },
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before);
    expect(state.sessionsById.s1.latestConversationSummary).toBe(summary);

    // A real change is a new version of the conversation content.
    state = sessionsSlice.reducer(
      state,
      setSessionConversationSummary({
        sessionId: "s1",
        summary: { sourceMessageId: "u1", content: "new sum" },
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
    expect(state.sessionsById.s1.latestConversationSummary?.content).toBe(
      "new sum",
    );
  });

  it("does not advance the revision clearing a summary that is already absent", () => {
    let state = stateWith({ history: [item("u1", "user", "a")] });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      clearSessionConversationSummary({ sessionId: "s1" }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before);

    state = sessionsSlice.reducer(
      state,
      setSessionConversationSummary({
        sessionId: "s1",
        summary: { sourceMessageId: "u1", content: "sum" },
      }),
    );
    const afterSet = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      clearSessionConversationSummary({ sessionId: "s1" }),
    );
    expect(state.sessionsById.s1.latestConversationSummary).toBeUndefined();
    expect(state.sessionsById.s1.conversationRevision).toBe(afterSet + 1);
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

describe("sessionsSlice — conversation revision ownership", () => {
  // 方案.md §五.16.1: only real content changes own the revision. Window
  // operations (hydration / prepend / trim) and construction-environment changes
  // (mode) must leave it alone — the identity comparison of §五.16.2 is what
  // makes the snapshot stale in those cases.
  it("does not advance the revision for hydration, prepend or trim", () => {
    let state = stateWith({
      history: [item("u1", "user", "1"), item("a1", "assistant", "2")],
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
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setSessionHistory({
        sessionId: "s1",
        history: [item("u1", "user", "1"), item("a1", "assistant", "2")],
        origin: "hydration",
      }),
    );
    state = sessionsSlice.reducer(
      state,
      prependSessionHistory({
        sessionId: "s1",
        items: [item("u0", "user", "older")],
        hasMore: true,
        newLoadedOffset: 1,
        totalCount: 4,
      } as any),
    );
    state = sessionsSlice.reducer(
      state,
      trimSessionHistoryWindow({
        sessionId: "s1",
        keepCount: 2,
        removedDiskItems: 0,
        fullDiskItemCount: 3,
        retainedDiskItemCount: 3,
      } as any),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before);
  });

  it("advances the revision for a content replacement", () => {
    let state = stateWith({ history: [item("u1", "user", "1")] });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setSessionHistory({
        sessionId: "s1",
        history: [item("u2", "user", "2")],
        origin: "content",
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
    // A content replacement makes the snapshot stale without blanking it.
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBeUndefined();
  });

  it("does not advance the revision when the mode changes", () => {
    let state = stateWith({ mode: "agent" });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setSessionMode({ sessionId: "s1", mode: "chat" }),
    );

    expect(state.sessionsById.s1.mode).toBe("chat");
    expect(state.sessionsById.s1.conversationRevision).toBe(before);
  });

  it("keeps the last-known metrics when a turn or the history is deleted", () => {
    // 方案.md §五.16: the value is the last-known one and stays visible; only the
    // freshness identity is dropped (deleteTurn / truncate included).
    const metrics = {
      inputTokens: 10,
      contextLength: 100,
      availableTokens: 90,
      contextPercentage: 0.5,
      exceedsContext: false,
    };
    for (const action of ["delete", "truncate"] as const) {
      let state = stateWith({
        history: [
          item("u1", "user", "one"),
          item("a1", "assistant", "two"),
          item("u2", "user", "three"),
        ],
        fullConversationMetrics: metrics,
        fullConversationMetricsMeta: {
          constructionIdentity: "identity",
          conversationRevision: 0,
          schemaVersion: 1,
        },
      });
      const before = state.sessionsById.s1.conversationRevision;

      state = sessionsSlice.reducer(
        state,
        action === "delete"
          ? deleteTurnByMessageId({ sessionId: "s1", messageId: "u1" })
          : truncateHistoryAfterMessageId({
              sessionId: "s1",
              messageId: "a1",
              assistantPlaceholderId: "p1",
            }),
      );

      expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
      expect(state.sessionsById.s1.fullConversationMetrics).toBe(metrics);
      expect(state.sessionsById.s1.fullConversationMetricsMeta).toBeUndefined();
    }
  });
});

describe("sessionsSlice — commitSubmittedTurn (Stage 2F)", () => {
  const placeholder = () => ({
    message: { id: "p1", role: "assistant", content: "" } as any,
    contextItems: [],
  });
  const submitted = (content = "hello") => ({
    message: { id: "n1", role: "user", content } as any,
    contextItems: [],
  });

  it("appends the turn and advances the content version exactly once", () => {
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    const before = state.sessionsById.s1.conversationRevision;
    const persistenceBefore = state.sessionsById.s1.persistence?.revision ?? 0;

    state = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "s1",
        userItem: submitted(),
        assistantPlaceholder: placeholder(),
        insertion: { kind: "append", expectedConversationRevision: before },
      }),
    );

    const session = state.sessionsById.s1;
    expect(session.history.map((entry) => entry.message.id)).toEqual([
      "u1",
      "n1",
      "p1",
    ]);
    expect(session.conversationRevision).toBe(before + 1);
    // One persistence advance as well: the whole submit is one mutation.
    expect(session.persistence?.revision).toBe(persistenceBefore + 1);
    expect(session.dirty).toBe(true);
    expect(session.persistence?.state).toBe("pending");
  });

  it("replaces the turn at the insertion point and truncates the tail", () => {
    let state = stateWith({
      history: [
        item("u1", "user", "1"),
        item("a1", "assistant", "2"),
        item("u2", "user", "3"),
        item("a2", "assistant", "4"),
      ],
    });

    state = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "s1",
        userItem: submitted("edited"),
        assistantPlaceholder: placeholder(),
        insertion: {
          kind: "replace",
          targetMessageId: "u2",
          expectedConversationRevision:
            state.sessionsById.s1.conversationRevision,
        },
      }),
    );

    expect(
      state.sessionsById.s1.history.map((entry) => entry.message.id),
    ).toEqual(["u1", "a1", "n1", "p1"]);
  });

  it("re-points a surviving summary carrier without a second version", () => {
    // A stale `sourceAbsoluteIndex` (what a hydration / paging move leaves behind)
    // must be corrected by the submit itself, as part of its single boundary — the
    // standalone `setSessionConversationSummary` action would have advanced the
    // content revision a second time.
    let state = stateWith({
      history: [
        item("u1", "user", "1"),
        {
          ...item("a1", "assistant", "2"),
          conversationSummary: "s0",
        } as ChatHistoryItemWithMessageId,
        item("u2", "user", "3"),
      ],
      latestConversationSummary: {
        sourceMessageId: "a1",
        sourceAbsoluteIndex: 0,
        content: "s0",
      },
    });
    const before = state.sessionsById.s1.conversationRevision;

    // Resending the turn *after* the carrier keeps it, at the same absolute index.
    state = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "s1",
        userItem: submitted(),
        assistantPlaceholder: placeholder(),
        insertion: {
          kind: "replace",
          targetMessageId: "u2",
          expectedConversationRevision: before,
        },
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
    expect(state.sessionsById.s1.latestConversationSummary).toEqual({
      sourceMessageId: "a1",
      sourceAbsoluteIndex: 1,
      content: "s0",
    });
  });

  it("drops a summary whose carrier the replacement truncated", () => {
    let state = stateWith({
      history: [
        item("u1", "user", "1"),
        {
          ...item("a1", "assistant", "2"),
          conversationSummary: "s0",
        } as ChatHistoryItemWithMessageId,
      ],
      latestConversationSummary: {
        sourceMessageId: "a1",
        sourceAbsoluteIndex: 1,
        content: "s0",
      },
    });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "s1",
        userItem: submitted(),
        assistantPlaceholder: placeholder(),
        insertion: {
          kind: "replace",
          targetMessageId: "a1",
          expectedConversationRevision: before,
        },
      }),
    );

    expect(state.sessionsById.s1.conversationRevision).toBe(before + 1);
    expect(state.sessionsById.s1.latestConversationSummary).toBeUndefined();
  });

  it("is a no-op for an unknown session", () => {
    const state = stateWith();
    const next = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "missing",
        userItem: submitted(),
        assistantPlaceholder: placeholder(),
        insertion: { kind: "append", expectedConversationRevision: 0 },
      }),
    );
    expect(next.sessionsById).toEqual(state.sessionsById);
  });

  it("refuses a submit whose expected revision is no longer current", () => {
    // The content moved on while the editor content was being resolved: the target
    // identity may describe something else now, so the whole submit is dropped.
    const state = stateWith({ history: [item("u1", "user", "hi")] });
    const stale = state.sessionsById.s1.conversationRevision - 1;

    const next = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "s1",
        userItem: submitted(),
        assistantPlaceholder: placeholder(),
        insertion: { kind: "append", expectedConversationRevision: stale },
      }),
    );

    expect(
      next.sessionsById.s1.history.map((entry) => entry.message.id),
    ).toEqual(["u1"]);
    expect(next.sessionsById.s1.conversationRevision).toBe(
      state.sessionsById.s1.conversationRevision,
    );
  });

  it("refuses a replace whose target identity is gone instead of appending", () => {
    const state = stateWith({
      history: [item("u1", "user", "1"), item("a1", "assistant", "2")],
    });
    const before = state.sessionsById.s1.conversationRevision;

    const next = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "s1",
        userItem: submitted(),
        assistantPlaceholder: placeholder(),
        insertion: {
          kind: "replace",
          targetMessageId: "gone",
          expectedConversationRevision: before,
        },
      }),
    );

    expect(
      next.sessionsById.s1.history.map((entry) => entry.message.id),
    ).toEqual(["u1", "a1"]);
    expect(next.sessionsById.s1.conversationRevision).toBe(before);
  });

  it("locates a replace target by identity, not by a stale index", () => {
    // The window grew in front of the target while the content was being resolved
    // (hydration / prepend): the same number addresses a different turn by then.
    let state = stateWith({
      history: [
        item("u1", "user", "1"),
        item("a1", "assistant", "2"),
        item("u2", "user", "3"),
        item("a2", "assistant", "4"),
      ],
    });
    const before = state.sessionsById.s1.conversationRevision;
    // Two items appear in front of the target; the content revision does not change
    // (hydration is not a new content version).
    state = sessionsSlice.reducer(
      state,
      setSessionHistory({
        sessionId: "s1",
        history: [
          item("x1", "user", "head"),
          item("x2", "assistant", "head answer"),
          ...state.sessionsById.s1.history,
        ],
        origin: "hydration",
      }),
    );
    expect(state.sessionsById.s1.conversationRevision).toBe(before);

    state = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "s1",
        userItem: submitted("edited"),
        assistantPlaceholder: placeholder(),
        insertion: {
          kind: "replace",
          targetMessageId: "u2",
          expectedConversationRevision: before,
        },
      }),
    );

    // The target and everything after it is replaced — the items before it survive,
    // including the two that arrived during the resolution.
    expect(
      state.sessionsById.s1.history.map((entry) => entry.message.id),
    ).toEqual(["x1", "x2", "u1", "a1", "n1", "p1"]);
  });

  it("appends at the current tail when the window grew during resolution", () => {
    let state = stateWith({ history: [item("u1", "user", "1")] });
    const before = state.sessionsById.s1.conversationRevision;
    state = sessionsSlice.reducer(
      state,
      setSessionHistory({
        sessionId: "s1",
        history: [
          ...state.sessionsById.s1.history,
          item("a1", "assistant", "2"),
        ],
        origin: "hydration",
      }),
    );

    state = sessionsSlice.reducer(
      state,
      commitSubmittedTurn({
        sessionId: "s1",
        userItem: submitted(),
        assistantPlaceholder: placeholder(),
        insertion: { kind: "append", expectedConversationRevision: before },
      }),
    );

    // Nothing is truncated: the append happened at the end of the grown window.
    expect(
      state.sessionsById.s1.history.map((entry) => entry.message.id),
    ).toEqual(["u1", "a1", "n1", "p1"]);
  });
});

describe("sessionsSlice — full conversation metrics", () => {
  const result = (revision: number, identity = "identity") => ({
    metrics: {
      inputTokens: 10,
      contextLength: 100,
      availableTokens: 90,
      contextPercentage: 0.1,
      exceedsContext: false,
    },
    meta: {
      constructionIdentity: identity,
      conversationRevision: revision,
      schemaVersion: 1,
    },
  });

  it("stores the result together with the validated environment stamp", () => {
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setSessionFullConversationMetrics({
        sessionId: "s1",
        result: result(before),
        environment: envStamp(),
      }),
    );

    expect(state.sessionsById.s1.fullConversationMetrics).toEqual(
      result(before).metrics,
    );
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toEqual(
      result(before).meta,
    );
    // fresh 判定要它做 O(1) 比较（§五.16.6）：没有它就只能算 stale。
    expect(state.sessionsById.s1.fullConversationMetricsEnvironment).toEqual(
      envStamp(),
    );
  });

  it("rejects a result for another conversation revision", () => {
    // 方案.md §五.16.5: the thunk validates the complete identity; the reducer
    // repeats the cheap revision check so a stale result can never claim
    // freshness.
    let state = stateWith({ history: [item("u1", "user", "hi")] });
    const before = state.sessionsById.s1.conversationRevision;

    state = sessionsSlice.reducer(
      state,
      setSessionFullConversationMetrics({
        sessionId: "s1",
        result: result(before + 1),
        environment: envStamp(),
      }),
    );

    expect(state.sessionsById.s1.fullConversationMetrics).toBeUndefined();
    expect(state.sessionsById.s1.fullConversationMetricsMeta).toBeUndefined();
    expect(
      state.sessionsById.s1.fullConversationMetricsEnvironment,
    ).toBeUndefined();
  });

  it("counts in-flight measurements and clears the count at zero", () => {
    // 方案.md §五.16.6 `measuring`: a counter, so two overlapping requests cannot
    // clear each other's state.
    let state = stateWith();
    const begin = () =>
      (state = sessionsSlice.reducer(
        state,
        beginSessionFullConversationMetricsMeasure({ sessionId: "s1" }),
      ));
    const end = () =>
      (state = sessionsSlice.reducer(
        state,
        endSessionFullConversationMetricsMeasure({ sessionId: "s1" }),
      ));

    expect(
      state.sessionsById.s1.fullConversationMetricsMeasuring,
    ).toBeUndefined();
    begin();
    begin();
    expect(state.sessionsById.s1.fullConversationMetricsMeasuring).toBe(2);
    end();
    expect(state.sessionsById.s1.fullConversationMetricsMeasuring).toBe(1);
    end();
    expect(
      state.sessionsById.s1.fullConversationMetricsMeasuring,
    ).toBeUndefined();
    // An extra end (never begun) must not go negative.
    end();
    expect(
      state.sessionsById.s1.fullConversationMetricsMeasuring,
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
    // Pure: no dirty, no revision, no conversationRevision — otherwise a save would
    // schedule another save (or invalidate the request-history cache) for free.
    expect(session.dirty).toBe(true);
    expect(session.persistence).toMatchObject({
      state: "pending",
      revision: 5,
    });
    expect(session.conversationRevision).toBe(
      state.sessionsById.s1.conversationRevision,
    );
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
      expect(next.sessionsById[id].conversationRevision).toBe(
        state.sessionsById[id].conversationRevision,
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
