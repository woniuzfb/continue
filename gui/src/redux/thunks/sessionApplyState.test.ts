import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallState } from "core";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionCodeBlockApplyIndex } from "../slices/sessionsSlice";
import { setSessionIsInEdit } from "../slices/sessionsSlice";
import {
  lookupApplyOrigin,
  registerCodeBlockApplyOrigin,
  registerEditApplyOrigin,
  registerToolApplyOrigin,
  resetApplyOrigins,
  resolveApplyRoute,
} from "../util/applyOrigins";
import {
  applySessionForEditTool,
  handleSessionApplyStateUpdate,
  routeApplyStateUpdate,
} from "./sessionApplyState";
import {
  registerSessionStreamRunner,
  resetSessionStreamRunner,
} from "./sessionTools";

function toolCall(
  toolCallId: string,
  status: ToolCallState["status"],
): ToolCallState {
  return {
    toolCallId,
    toolCall: {
      id: toolCallId,
      type: "function",
      function: { name: "edit_existing_file", arguments: "{}" },
    },
    status,
    parsedArgs: {},
  };
}

function assistant(
  id: string,
  toolCallStates: ToolCallState[],
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role: "assistant",
      content: "",
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
    toolCallStates,
  };
}

function makeStore(
  toolCallStatus: ToolCallState["status"] = "calling",
  toolSettings: Record<string, string> = {},
) {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [assistant("a1", [toolCall("t1", toolCallStatus)])],
    stream: { status: "streaming", requestId: "req-1" },
  });
  const s2 = initialSessionRuntime("s2", "Chat 2", {
    history: [assistant("a2", [toolCall("other", "calling")])],
  });
  return createMockStore({
    sessions: {
      activeSessionId: "s2",
      tabOrder: ["s1", "s2"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        s2: { sessionId: "s2", title: "Chat 2", loadState: "loaded" },
      },
      sessionsById: { s1, s2 },
    },
    ui: {
      ...(createMockStore().getState() as any).ui,
      toolSettings,
    },
  });
}

function session(store: ReturnType<typeof makeStore>, sessionId = "s1") {
  return (store.getState() as any).sessions.sessionsById[sessionId];
}

function toolState(store: ReturnType<typeof makeStore>, toolCallId = "t1") {
  return session(store)
    .history.flatMap((item: any) => item.toolCallStates ?? [])
    .find((state: any) => state.toolCallId === toolCallId);
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("sessionApplyState", () => {
  beforeEach(() => {
    resetApplyOrigins();
    resetSessionStreamRunner();
  });

  it("records the origin and creates apply state in the target session", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(
      store,
      applySessionForEditTool({
        sessionId: "s1",
        toolCallId: "t1",
        streamId: "stream-1",
        text: "new contents",
        filepath: "file:///x.ts",
      }),
    );

    expect(lookupApplyOrigin("stream-1")).toEqual({
      kind: "tool",
      sessionId: "s1",
      toolCallId: "t1",
    });
    expect(session(store).codeBlockApplyStates.states).toEqual([
      { streamId: "stream-1", toolCallId: "t1", status: "not-started" },
    ]);
    expect(request).toHaveBeenCalledWith(
      "applyToFile",
      expect.objectContaining({ streamId: "stream-1", sessionId: "s1" }),
    );
    // The active session is untouched.
    expect(session(store, "s2").codeBlockApplyStates.states).toEqual([]);
  });

  it("marks the tool errored when applyToFile fails mid-call", async () => {
    const store = makeStore();
    store.mockIdeMessenger.request = vi.fn(async (type: string) => {
      if (type === "applyToFile") {
        return { status: "error", error: "nope", done: true };
      }
      return { status: "success", content: undefined, done: true };
    }) as any;

    await run(
      store,
      applySessionForEditTool({
        sessionId: "s1",
        toolCallId: "t1",
        streamId: "stream-1",
        text: "new contents",
        filepath: "file:///x.ts",
      }),
    );

    // Legacy parity: the closed handler runs after the error and replaces the
    // Apply Error output with the Edit Failed guidance.
    const state = toolState(store);
    expect(state.status).toBe("errored");
    expect(state.output?.[0]).toMatchObject({ name: "Edit Failed" });
    expect(session(store).codeBlockApplyStates.states[0].status).toBe("closed");
  });

  it("closes an accepted edit and continues the tool loop", async () => {
    const store = makeStore();
    const runner = vi.fn(async () => {});
    registerSessionStreamRunner(runner);

    await run(
      store,
      handleSessionApplyStateUpdate({
        sessionId: "s1",
        applyState: {
          streamId: "stream-1",
          toolCallId: "t1",
          status: "closed",
          filepath: "file:///x.ts",
        },
      }),
    );

    const state = toolState(store);
    expect(state.status).toBe("done");
    expect(state.output?.[0]).toMatchObject({ name: "Edit Success" });
    expect(runner).toHaveBeenCalledWith({
      sessionId: "s1",
      requestId: "req-1",
      depth: 1,
    });
    expect(session(store).codeBlockApplyStates.curIndex).toBe(0);
  });

  it("keeps auto-formatting context when the editor reports a diff", async () => {
    const store = makeStore();

    await run(
      store,
      handleSessionApplyStateUpdate({
        sessionId: "s1",
        applyState: {
          streamId: "stream-1",
          toolCallId: "t1",
          status: "closed",
          filepath: "file:///x.ts",
          autoFormattingDiff: "@@ -1 +1 @@",
        },
      }),
    );

    expect(toolState(store).output?.[0]).toMatchObject({
      name: "Auto-formatting Applied",
    });
  });

  it("does not continue the loop for a rejected edit", async () => {
    const store = makeStore("canceled");
    const runner = vi.fn(async () => {});
    registerSessionStreamRunner(runner);

    await run(
      store,
      handleSessionApplyStateUpdate({
        sessionId: "s1",
        applyState: {
          streamId: "stream-1",
          toolCallId: "t1",
          status: "closed",
          filepath: "file:///x.ts",
        },
      }),
    );

    expect(runner).not.toHaveBeenCalled();
    expect(toolState(store).status).toBe("canceled");
  });

  it("auto-accepts the diff for allowedWithoutPermission tools", async () => {
    const store = makeStore("calling", {
      edit_existing_file: "allowedWithoutPermission",
    });
    const post = vi.spyOn(store.mockIdeMessenger, "post");

    await run(
      store,
      handleSessionApplyStateUpdate({
        sessionId: "s1",
        applyState: {
          streamId: "stream-1",
          toolCallId: "t1",
          status: "done",
          filepath: "file:///x.ts",
        },
      }),
    );

    expect(post).toHaveBeenCalledWith("acceptDiff", {
      streamId: "stream-1",
      filepath: "file:///x.ts",
      // The IDE's `closed` answer has to name this session (P3).
      sessionId: "s1",
    });
  });

  it("is a no-op for an unknown session or tool call", async () => {
    const store = makeStore();

    await run(
      store,
      handleSessionApplyStateUpdate({
        sessionId: "nope",
        applyState: {
          streamId: "stream-1",
          toolCallId: "t1",
          status: "closed",
        },
      }),
    );
    await run(
      store,
      handleSessionApplyStateUpdate({
        sessionId: "s1",
        applyState: {
          streamId: "stream-1",
          toolCallId: "nope",
          status: "closed",
        },
      }),
    );

    expect(toolState(store).status).toBe("calling");
  });

  it("advances and resets the per-session code block cursor", async () => {
    const store = makeStore();

    await run(
      store,
      handleSessionApplyStateUpdate({
        sessionId: "s1",
        applyState: {
          streamId: "stream-1",
          toolCallId: "t1",
          status: "done",
          filepath: "file:///x.ts",
        },
      }),
    );
    expect(session(store).codeBlockApplyStates.curIndex).toBe(1);

    store.dispatch(resetSessionCodeBlockApplyIndex({ sessionId: "s1" }));
    expect(session(store).codeBlockApplyStates.curIndex).toBe(0);
    expect(session(store, "s2").codeBlockApplyStates.curIndex).toBe(0);
  });
});

/**
 * 方案.md §五.21. The IDE's `updateApplyState` event carries no sessionId, and
 * the apply-origin registry is its only authority. Every case here has the
 * *other* tab active, so any regression back to `origin?.sessionId ??
 * activeSessionId` routes into the wrong session and fails.
 */
describe("apply state routing", () => {
  beforeEach(() => {
    resetApplyOrigins();
    resetSessionStreamRunner();
  });

  function setInEdit(
    store: ReturnType<typeof makeStore>,
    sessionId: string,
    isInEdit: boolean,
  ) {
    store.dispatch(setSessionIsInEdit({ sessionId, isInEdit }));
  }

  function editApplyState(store: ReturnType<typeof makeStore>) {
    return session(store).editState.applyState;
  }

  it("drops an event whose stream has no recorded origin", async () => {
    const store = makeStore();
    setInEdit(store, "s1", true);
    setInEdit(store, "s2", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    // Edit-shaped but unregistered. The legacy fallback resolved this to the
    // active session (s2) and closed s2's edit mode.
    await run(
      store,
      routeApplyStateUpdate({
        applyState: { streamId: EDIT_MODE_STREAM_ID, status: "closed" },
      }),
    );

    expect(session(store, "s1").isInEdit).toBe(true);
    expect(session(store, "s2").isInEdit).toBe(true);
    expect(editApplyState(store).status).toBe("not-started");
    expect(session(store, "s1").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
    expect(session(store, "s2").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
    expect(request).not.toHaveBeenCalledWith("history/save", expect.anything());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      streamId: EDIT_MODE_STREAM_ID,
      status: "closed",
      editModeStream: true,
      reason: "unknown-origin",
    });
    warn.mockRestore();
  });

  it("routes a tool apply to the registered session, not the active one", async () => {
    const store = makeStore();
    registerToolApplyOrigin("stream-1", {
      sessionId: "s1",
      toolCallId: "t1",
    });

    // The payload omits toolCallId: the registered origin supplies it.
    await run(
      store,
      routeApplyStateUpdate({
        applyState: {
          streamId: "stream-1",
          status: "done",
          filepath: "file:///x.ts",
        },
      }),
    );

    expect(session(store, "s1").codeBlockApplyStates.states).toEqual([
      {
        streamId: "stream-1",
        toolCallId: "t1",
        status: "done",
        filepath: "file:///x.ts",
      },
    ]);
    expect(session(store, "s1").codeBlockApplyStates.curIndex).toBe(1);
    expect(session(store, "s2").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
  });

  it("routes a chat code-block apply to its origin session", async () => {
    const store = makeStore();
    registerCodeBlockApplyOrigin("codeblock-1", { sessionId: "s1" });

    await run(
      store,
      routeApplyStateUpdate({
        applyState: { streamId: "codeblock-1", status: "streaming" },
      }),
    );

    expect(session(store, "s1").codeBlockApplyStates.states).toEqual([
      { streamId: "codeblock-1", status: "streaming" },
    ]);
    expect(session(store, "s2").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
  });

  it("drops a payload toolCallId that contradicts the recorded origin", async () => {
    const store = makeStore();
    registerToolApplyOrigin("stream-1", {
      sessionId: "s1",
      toolCallId: "t1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await run(
      store,
      routeApplyStateUpdate({
        applyState: { streamId: "stream-1", toolCallId: "t9", status: "done" },
      }),
    );

    expect(session(store, "s1").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      reason: "tool-call-id-mismatch",
    });
    warn.mockRestore();
  });

  it("routes an edit apply to its origin session and closes only that edit", async () => {
    const store = makeStore();
    setInEdit(store, "s1", true);
    setInEdit(store, "s2", true);
    registerEditApplyOrigin(EDIT_MODE_STREAM_ID, { sessionId: "s1" });

    await run(
      store,
      routeApplyStateUpdate({
        applyState: { streamId: EDIT_MODE_STREAM_ID, status: "done" },
      }),
    );

    expect(editApplyState(store).status).toBe("done");
    expect(session(store, "s2").editState.applyState.status).toBe(
      "not-started",
    );

    await run(
      store,
      routeApplyStateUpdate({
        applyState: { streamId: EDIT_MODE_STREAM_ID, status: "closed" },
      }),
    );

    expect(session(store, "s1").isInEdit).toBe(false);
    expect(session(store, "s2").isInEdit).toBe(true);
  });

  /**
   * 方案.md §五.21 P3: a new host names the session in the payload, which is
   * what makes two sessions' edit streams distinguishable — they share the
   * fixed `EDIT_MODE_STREAM_ID`, so the registry has a single slot for both.
   */
  it("routes by the payload sessionId without needing a registration", async () => {
    const store = makeStore();

    await run(
      store,
      routeApplyStateUpdate({
        applyState: {
          streamId: "codeblock-1",
          status: "streaming",
          sessionId: "s1",
        },
      }),
    );

    // The runtime slot is keyed by session, so it must not also carry one.
    expect(session(store, "s1").codeBlockApplyStates.states).toEqual([
      { streamId: "codeblock-1", status: "streaming" },
    ]);
    expect(session(store, "s2").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
  });

  /**
   * P3.1: with the fixed edit streamId the registry slot is shared by every
   * session, so a stale entry must not veto the payload's session — otherwise
   * S1's own events are deterministically dropped as soon as S2 starts an edit.
   */
  it("keeps two sessions' edit streams apart under one shared streamId", async () => {
    const store = makeStore();
    setInEdit(store, "s1", true);
    setInEdit(store, "s2", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Both edits register into the same fixed-streamId slot; the last one wins.
    registerEditApplyOrigin(EDIT_MODE_STREAM_ID, { sessionId: "s2" });

    await run(
      store,
      routeApplyStateUpdate({
        applyState: {
          streamId: EDIT_MODE_STREAM_ID,
          status: "done",
          sessionId: "s2",
        },
      }),
    );
    expect(session(store, "s2").editState.applyState.status).toBe("done");
    expect(editApplyState(store).status).toBe("not-started");

    // S1's in-flight event still names S1. The registry slot says S2, which is
    // stale, not a conflict: it is routed to S1 (and logged).
    await run(
      store,
      routeApplyStateUpdate({
        applyState: {
          streamId: EDIT_MODE_STREAM_ID,
          status: "done",
          sessionId: "s1",
        },
      }),
    );

    expect(editApplyState(store).status).toBe("done");
    expect(session(store, "s2").editState.applyState.status).toBe("done");
    expect(session(store, "s1").isInEdit).toBe(true);
    expect(session(store, "s2").isInEdit).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      payloadSessionId: "s1",
      staleOriginSessionId: "s2",
      staleOriginKind: "edit",
    });
    warn.mockRestore();
  });

  it("drops a payload sessionId that has no loaded runtime", async () => {
    const store = makeStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await run(
      store,
      routeApplyStateUpdate({
        applyState: {
          streamId: "stream-1",
          status: "done",
          sessionId: "ghost",
        },
      }),
    );

    expect(session(store, "s1").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
    expect(session(store, "s2").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
    expect(warn.mock.calls[0][1]).toMatchObject({ reason: "unknown-session" });
    warn.mockRestore();
  });

  it("routes a payload sessionId over a stale registered origin", async () => {
    const store = makeStore();
    // The slot belongs to s1 from an earlier apply; this event says s2 (P3.1).
    registerCodeBlockApplyOrigin("codeblock-1", { sessionId: "s1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await run(
      store,
      routeApplyStateUpdate({
        applyState: {
          streamId: "codeblock-1",
          status: "done",
          sessionId: "s2",
        },
      }),
    );

    expect(session(store, "s2").codeBlockApplyStates.states).toEqual([
      { streamId: "codeblock-1", status: "done" },
    ]);
    expect(session(store, "s1").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      payloadSessionId: "s2",
      staleOriginSessionId: "s1",
    });
    warn.mockRestore();
  });

  it("drops events after the registry is cleared, then routes them again", async () => {
    const store = makeStore();
    registerToolApplyOrigin("stream-1", {
      sessionId: "s1",
      toolCallId: "t1",
    });
    // A webview reload empties the in-memory registry.
    resetApplyOrigins();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const closed = {
      applyState: {
        streamId: "stream-1",
        toolCallId: "t1",
        status: "closed" as const,
      },
    };

    await run(store, routeApplyStateUpdate(closed));

    expect(toolState(store).status).toBe("calling");
    expect(session(store, "s2").codeBlockApplyStates).toEqual({
      states: [],
      curIndex: 0,
    });

    // Same event, registered again: it is routed, so the earlier drop was the
    // registry's doing and not a property of the payload.
    registerToolApplyOrigin("stream-1", {
      sessionId: "s1",
      toolCallId: "t1",
    });
    await run(store, routeApplyStateUpdate(closed));

    expect(toolState(store).status).toBe("done");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/**
 * P3.1 at the decision level: the payload's sessionId is the routing identity,
 * while a tool origin may only *confirm* a tool call **within that same
 * session**. A tool origin belonging to another session is stale and must not
 * leak its `toolCallId` into this event.
 */
describe("resolveApplyRoute", () => {
  const context = {
    sessionExists: (sessionId: string) =>
      sessionId === "s1" || sessionId === "s2",
  };

  beforeEach(() => {
    resetApplyOrigins();
  });

  it("never borrows a toolCallId from another session's origin", () => {
    registerToolApplyOrigin("stream-1", {
      sessionId: "s2",
      toolCallId: "t2",
    });

    const route = resolveApplyRoute(
      { streamId: "stream-1", status: "done", sessionId: "s1" },
      context,
    );

    expect(route).toMatchObject({
      kind: "route",
      sessionId: "s1",
      toolCallId: undefined,
    });
    expect((route as any).staleOrigin).toMatchObject({
      kind: "tool",
      sessionId: "s2",
    });
  });

  it("keeps the payload's own toolCallId over a foreign origin", () => {
    registerToolApplyOrigin("stream-1", {
      sessionId: "s2",
      toolCallId: "t2",
    });

    const route = resolveApplyRoute(
      {
        streamId: "stream-1",
        status: "done",
        sessionId: "s1",
        toolCallId: "t1",
      },
      context,
    );

    // Not t2, and not a drop: the registered tool call belongs to s2.
    expect(route).toMatchObject({
      kind: "route",
      sessionId: "s1",
      toolCallId: "t1",
    });
  });

  it("drops a toolCallId that contradicts a same-session tool origin", () => {
    registerToolApplyOrigin("stream-1", {
      sessionId: "s1",
      toolCallId: "t1",
    });

    expect(
      resolveApplyRoute(
        {
          streamId: "stream-1",
          status: "done",
          sessionId: "s1",
          toolCallId: "t9",
        },
        context,
      ),
    ).toEqual({ kind: "drop", reason: "tool-call-id-mismatch" });
  });

  it("uses the registered toolCallId when the payload omits it", () => {
    registerToolApplyOrigin("stream-1", {
      sessionId: "s1",
      toolCallId: "t1",
    });

    expect(
      resolveApplyRoute(
        { streamId: "stream-1", status: "done", sessionId: "s1" },
        context,
      ),
    ).toMatchObject({ kind: "route", sessionId: "s1", toolCallId: "t1" });
  });

  it("posts acceptDiff on done in agent-full mode without fabricating closed before IDE confirmation", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore("calling");
      const postSpy = vi.spyOn(store.mockIdeMessenger, "post");
      const runner = vi.fn(async () => {});
      registerSessionStreamRunner(runner);

      // Put s1 into agent-full mode
      (store.getState() as any).sessions.sessionsById.s1.mode = "agent-full";

      await run(
        store,
        handleSessionApplyStateUpdate({
          sessionId: "s1",
          applyState: {
            streamId: "stream-1",
            toolCallId: "t1",
            status: "done",
            filepath: "file:///x.ts",
          },
        }),
      );

      expect(postSpy).toHaveBeenCalledWith("acceptDiff", {
        streamId: "stream-1",
        filepath: "file:///x.ts",
        sessionId: "s1",
      });

      // Even after 5 seconds without an IDE `closed` event, the tool call must
      // remain `calling` and the stream runner must not be triggered early.
      await vi.advanceTimersByTimeAsync(5000);
      expect(toolState(store).status).toBe("calling");
      expect(runner).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
