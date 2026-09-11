import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallState } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { selectSessionById } from "../selectors/sessions";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  type SessionRuntimeState,
  initialSessionRuntime,
} from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import {
  approveToolCall,
  approveToolCalls,
  continueToolLoop,
  registerSessionStreamRunner,
  rejectToolCall,
  rejectToolCalls,
  resetSessionStreamRunner,
} from "./sessionTools";

function toolCallState(
  toolCallId: string,
  status: ToolCallState["status"] = "generated",
  name = "run_terminal_cmd",
): ToolCallState {
  return {
    toolCallId,
    toolCall: {
      id: toolCallId,
      type: "function",
      function: { name, arguments: "{}" },
    },
    status,
    parsedArgs: {},
  };
}

function assistantWithToolCalls(
  messageId: string,
  toolCallStates: ToolCallState[],
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id: messageId,
      role: "assistant",
      content: "calling a tool",
      toolCalls: toolCallStates.map((state) => state.toolCall),
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
    toolCallStates,
  };
}

function userItem(id: string): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role: "user",
      content: "do it",
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

type StoreOptions = {
  toolCallStates?: ToolCallState[];
  requestId?: string;
  continueAfterToolRejection?: boolean;
  sessionOverrides?: Partial<SessionRuntimeState>;
};

/**
 * s1 owns the tool calls; s2 is the active tab. Every assertion on s2 proves
 * the tool loop never reads or writes the active session.
 */
function makeStore(options: StoreOptions = {}) {
  const {
    toolCallStates = [toolCallState("t1")],
    requestId = "req-1",
    continueAfterToolRejection = false,
    sessionOverrides = {},
  } = options;

  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [userItem("u1"), assistantWithToolCalls("a1", toolCallStates)],
    pendingApprovalCount: toolCallStates.filter(
      (state) => state.status === "generated",
    ).length,
    stream: { status: "streaming", requestId },
    ...sessionOverrides,
  });
  const s2 = initialSessionRuntime("s2", "Chat 2", {
    history: [
      userItem("u2"),
      assistantWithToolCalls("a2", [toolCallState("other")]),
    ],
    pendingApprovalCount: 1,
    stream: { status: "streaming", requestId: "req-2" },
  });

  const store = createMockStore({
    sessions: {
      activeSessionId: "s2",
      tabOrder: ["s1", "s2"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        s2: { sessionId: "s2", title: "Chat 2", loadState: "loaded" },
      },
      sessionsById: { s1, s2 },
    },
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        ui: { continueAfterToolRejection },
      },
    },
  });
  return store;
}

function session(store: ReturnType<typeof makeStore>, sessionId = "s1") {
  return selectSessionById(store.getState() as any, sessionId)!;
}

function toolState(
  store: ReturnType<typeof makeStore>,
  toolCallId: string,
  sessionId = "s1",
): ToolCallState {
  return session(store, sessionId)
    .history.flatMap((item) => item.toolCallStates ?? [])
    .find((state) => state.toolCallId === toolCallId)!;
}

function toolMessages(
  store: ReturnType<typeof makeStore>,
  toolCallId: string,
  sessionId = "s1",
) {
  return session(store, sessionId).history.filter(
    (item) =>
      item.message.role === "tool" && item.message.toolCallId === toolCallId,
  );
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("sessionTools", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamRunner();
  });

  it("approves a core tool call in the target session and records the result", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const outcome = await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );

    expect(outcome).toMatchObject({ status: "approved", toolCallId: "t1" });
    expect(request).toHaveBeenCalledWith("tools/call", {
      toolCall: expect.objectContaining({
        function: expect.objectContaining({ name: "run_terminal_cmd" }),
      }),
    });

    const state = toolState(store, "t1");
    expect(state.status).toBe("done");
    expect(state.output?.[0].content).toBe("Tool call executed successfully");
    expect(session(store).pendingApprovalCount).toBe(0);
    expect(toolMessages(store, "t1")).toHaveLength(1);
  });

  it("enqueues an immediate save on the approval boundary", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
  });

  it("never reads or writes the active session", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );

    const active = session(store, "s2");
    expect(active.pendingApprovalCount).toBe(1);
    expect(active.history.flatMap((item) => item.toolCallStates ?? [])).toEqual(
      [expect.objectContaining({ toolCallId: "other", status: "generated" })],
    );
    expect(request).not.toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({ sessionId: "s2" }),
    );
  });

  it("ignores an approval for a stale requestId", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const outcome = await run(
      store,
      approveToolCall({ sessionId: "s1", requestId: "old", toolCallId: "t1" }),
    );

    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "stale-request",
    });
    expect(request).not.toHaveBeenCalledWith("tools/call", expect.anything());
    expect(toolState(store, "t1").status).toBe("generated");
  });

  it("does not re-execute a call that is not awaiting approval", async () => {
    const store = makeStore({
      toolCallStates: [toolCallState("t1", "done")],
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const outcome = await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );

    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "not-awaiting-approval",
    });
    expect(request).not.toHaveBeenCalledWith("tools/call", expect.anything());
  });

  it("skips a missing session or a missing tool call", async () => {
    const store = makeStore();

    await expect(
      run(
        store,
        approveToolCall({
          sessionId: "nope",
          requestId: "req-1",
          toolCallId: "t1",
        }),
      ),
    ).resolves.toMatchObject({ status: "skipped", reason: "session-missing" });

    await expect(
      run(
        store,
        approveToolCall({
          sessionId: "s1",
          requestId: "req-1",
          toolCallId: "nope",
        }),
      ),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "tool-call-missing",
    });
  });

  it("records a failed tool as an errored call instead of leaving it calling", async () => {
    const store = makeStore();
    store.mockIdeMessenger.responseHandlers["tools/call"] = async () => ({
      contextItems: [],
      errorMessage: "command not found",
      errorReason: "tool_failed" as any,
    });

    const outcome = await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );

    expect(outcome).toMatchObject({
      status: "errored",
      errorMessage: "command not found",
      continuationRequested: false,
    });
    const state = toolState(store, "t1");
    expect(state.status).toBe("errored");
    expect(state.output?.[0].name).toBe("Tool Call Error");
  });

  it("rejects a call without executing it", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const outcome = await run(
      store,
      rejectToolCall({ sessionId: "s1", requestId: "req-1", toolCallId: "t1" }),
    );

    expect(outcome.status).toBe("rejected");
    expect(request).not.toHaveBeenCalledWith("tools/call", expect.anything());
    const state = toolState(store, "t1");
    expect(state.status).toBe("canceled");
    expect(state.output).toBeUndefined();
    expect(session(store).pendingApprovalCount).toBe(0);
  });

  it("continues the turn after a rejection when continueAfterToolRejection is on", async () => {
    const store = makeStore({ continueAfterToolRejection: true });
    const runner = vi.fn(async () => {});
    registerSessionStreamRunner(runner);

    const outcome = await run(
      store,
      rejectToolCall({ sessionId: "s1", requestId: "req-1", toolCallId: "t1" }),
    );

    expect(outcome).toMatchObject({
      status: "rejected",
      continuationRequested: true,
    });
    expect(toolState(store, "t1").output?.[0]).toMatchObject({ hidden: true });
    expect(runner).toHaveBeenCalledWith({
      sessionId: "s1",
      requestId: "req-1",
      depth: 1,
    });
  });

  it("stops after the tool result when no stream runner is registered", async () => {
    const store = makeStore();

    const outcome = await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );

    expect(outcome.continuationRequested).toBe(false);
    expect(session(store).stream.requestId).toBe("req-1");
  });

  it("waits for sibling calls before continuing, and appends each result once", async () => {
    const store = makeStore({
      toolCallStates: [toolCallState("t1"), toolCallState("t2")],
    });
    const runner = vi.fn(async () => {});
    registerSessionStreamRunner(runner);

    const first = await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );
    expect(first).toMatchObject({
      status: "approved",
      continuationRequested: false,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(toolMessages(store, "t1")).toHaveLength(1);
    expect(session(store).pendingApprovalCount).toBe(1);

    // Retrying the same continuation must not duplicate the tool message.
    const waiting = await run(
      store,
      continueToolLoop({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );
    expect(waiting).toMatchObject({
      status: "waiting",
      reason: "pending-tool-calls",
    });
    expect(toolMessages(store, "t1")).toHaveLength(1);
    expect(runner).not.toHaveBeenCalled();

    const second = await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t2",
      }),
    );
    expect(second.continuationRequested).toBe(true);
    expect(toolMessages(store, "t2")).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith({
      sessionId: "s1",
      requestId: "req-1",
      depth: 1,
    });
  });

  it("batch approve executes every call and continues the loop once", async () => {
    const store = makeStore({
      toolCallStates: [toolCallState("t1"), toolCallState("t2")],
    });
    const runner = vi.fn(async () => {});
    registerSessionStreamRunner(runner);

    const outcomes = await run(
      store,
      approveToolCalls({
        sessionId: "s1",
        requestId: "req-1",
        toolCallIds: ["t1", "t2"],
      }),
    );

    expect(outcomes.map((outcome: any) => outcome.status)).toEqual([
      "approved",
      "approved",
    ]);
    expect(toolState(store, "t1").status).toBe("done");
    expect(toolState(store, "t2").status).toBe("done");
    expect(toolMessages(store, "t1")).toHaveLength(1);
    expect(toolMessages(store, "t2")).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(session(store).pendingApprovalCount).toBe(0);
  });

  it("batch reject closes every call without executing any of them", async () => {
    const store = makeStore({
      toolCallStates: [toolCallState("t1"), toolCallState("t2")],
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const outcomes = await run(
      store,
      rejectToolCalls({
        sessionId: "s1",
        requestId: "req-1",
        toolCallIds: ["t1", "t2"],
      }),
    );

    expect(outcomes.map((outcome: any) => outcome.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(request).not.toHaveBeenCalledWith("tools/call", expect.anything());
    expect(toolState(store, "t1").status).toBe("canceled");
    expect(toolState(store, "t2").status).toBe("canceled");
    expect(session(store).pendingApprovalCount).toBe(0);
  });

  it("continueToolLoop ignores a stale requestId", async () => {
    const store = makeStore();
    const runner = vi.fn(async () => {});
    registerSessionStreamRunner(runner);

    const outcome = await run(
      store,
      continueToolLoop({
        sessionId: "s1",
        requestId: "old",
        toolCallId: "t1",
      }),
    );

    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "stale-request",
    });
    expect(runner).not.toHaveBeenCalled();
    expect(toolMessages(store, "t1")).toHaveLength(0);
  });
});

describe("tool saves never carry a measurement (Stage 2D 收口)", () => {
  it("keeps the mid-turn tool save measurement-free", async () => {
    // 方案.md §五.16.4「按显式开关，不按 reason」+ Step 1：live 回合内的工具写入只推进
    // persistence revision 并 arm 终态提交；内容版本边界是 terminal，不是这次中间保存。
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: "req-1",
        toolCallId: "t1",
      }),
    );

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
    for (const call of request.mock.calls) {
      if (call[0] === "history/save") {
        expect((call[1] as any).fullConversationMeasurement).toBeUndefined();
      }
    }
  });
});
