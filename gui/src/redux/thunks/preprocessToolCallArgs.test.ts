import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallState } from "core";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { preprocessSessionToolCalls } from "./preprocessToolCallArgs";

function toolCall(toolCallId: string): ToolCallState {
  return {
    toolCallId,
    toolCall: {
      id: toolCallId,
      type: "function",
      function: { name: "run_terminal_cmd", arguments: "{}" },
    },
    status: "generated",
    parsedArgs: { command: "ls" },
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

function makeStore() {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [assistant("a1", [toolCall("t1")])],
    pendingApprovalCount: 1,
    stream: { status: "streaming", requestId: "req-1" },
  });
  const s2 = initialSessionRuntime("s2", "Chat 2", {
    history: [assistant("a2", [toolCall("other")])],
    pendingApprovalCount: 1,
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
  });
}

function toolState(store: ReturnType<typeof makeStore>, sessionId: string) {
  return (
    (store.getState() as any).sessions.sessionsById[sessionId].history[0]
      .toolCallStates?.[0] ?? undefined
  );
}

describe("preprocessSessionToolCalls", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("stores preprocessed args on the target session's tool call", async () => {
    const store = makeStore();
    store.mockIdeMessenger.responseHandlers["tools/preprocessArgs"] =
      async () => ({ preprocessedArgs: { command: "ls -la" } });

    await preprocessSessionToolCalls(
      {
        dispatch: store.dispatch as any,
        getState: store.getState as any,
        ideMessenger: store.mockIdeMessenger,
      },
      { sessionId: "s1", toolCallIds: ["t1"] },
    );

    expect(toolState(store, "s1")?.processedArgs).toEqual({
      command: "ls -la",
    });
    expect(toolState(store, "s1")?.status).toBe("generated");
    // The active session is untouched.
    expect(toolState(store, "s2")?.processedArgs).toBeUndefined();
  });

  it("marks the call errored with an invalid-args output", async () => {
    const store = makeStore();
    store.mockIdeMessenger.responseHandlers["tools/preprocessArgs"] =
      async () => ({
        errorMessage: "unexpected token",
        errorReason: "invalid_args" as any,
      });

    await preprocessSessionToolCalls(
      {
        dispatch: store.dispatch as any,
        getState: store.getState as any,
        ideMessenger: store.mockIdeMessenger,
      },
      { sessionId: "s1", toolCallIds: ["t1"] },
    );

    const state = toolState(store, "s1");
    expect(state?.status).toBe("errored");
    expect(state?.output?.[0]).toMatchObject({ name: "Invalid Tool Call" });
    expect(
      (store.getState() as any).sessions.sessionsById["s1"]
        .pendingApprovalCount,
    ).toBe(0);
  });

  it("skips unknown sessions and unknown tool calls without a request", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await preprocessSessionToolCalls(
      {
        dispatch: store.dispatch as any,
        getState: store.getState as any,
        ideMessenger: store.mockIdeMessenger,
      },
      { sessionId: "nope", toolCallIds: ["t1"] },
    );
    await preprocessSessionToolCalls(
      {
        dispatch: store.dispatch as any,
        getState: store.getState as any,
        ideMessenger: store.mockIdeMessenger,
      },
      { sessionId: "s1", toolCallIds: ["nope"] },
    );

    expect(request).not.toHaveBeenCalled();
  });
});
