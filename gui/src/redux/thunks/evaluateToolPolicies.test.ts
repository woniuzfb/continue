import { describe, expect, it } from "vitest";
import type { Tool, ToolCallState } from "core";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { evaluateSessionToolPolicies } from "./evaluateToolPolicies";

function toolCall(
  toolCallId: string,
  name = "run_terminal_cmd",
): ToolCallState {
  return {
    toolCallId,
    toolCall: {
      id: toolCallId,
      type: "function",
      function: { name, arguments: "{}" },
    },
    status: "generated",
    parsedArgs: { command: "rm -rf /" },
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

const ACTIVE_TOOLS: Tool[] = [
  {
    type: "function",
    function: { name: "run_terminal_cmd" },
    displayTitle: "Run command",
    wouldLikeTo: "run a command",
    readonly: false,
    group: "built-in",
  },
];

function makeStore() {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [assistant("a1", [toolCall("t1"), toolCall("t2")])],
    pendingApprovalCount: 2,
    stream: { status: "streaming", requestId: "req-1" },
  });
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1 },
    },
  });
}

function toolState(store: ReturnType<typeof makeStore>, toolCallId: string) {
  const state = store.getState() as any;
  return state.sessions.sessionsById["s1"].history
    .flatMap((item: any) => item.toolCallStates ?? [])
    .find((toolCallState: any) => toolCallState.toolCallId === toolCallId);
}

function api(store: ReturnType<typeof makeStore>) {
  return {
    dispatch: store.dispatch as any,
    getState: store.getState as any,
    ideMessenger: store.mockIdeMessenger,
  };
}

describe("evaluateSessionToolPolicies", () => {
  it("marks a disabled call errored and keeps it out of the approval count", async () => {
    const store = makeStore();

    const policies = await evaluateSessionToolPolicies(api(store), {
      sessionId: "s1",
      toolCallIds: ["t1"],
      activeTools: ACTIVE_TOOLS,
      toolPolicies: { run_terminal_cmd: "disabled" },
    });

    expect(policies).toHaveLength(1);
    expect(policies[0].policy).toBe("disabled");
    const state = toolState(store, "t1");
    expect(state?.status).toBe("errored");
    expect(state?.output?.[0]).toMatchObject({
      name: "Security Policy Violation",
    });
    expect(
      (store.getState() as any).sessions.sessionsById["s1"]
        .pendingApprovalCount,
    ).toBe(1);
  });

  it("leaves allowedWithPermission calls awaiting approval", async () => {
    const store = makeStore();

    const policies = await evaluateSessionToolPolicies(api(store), {
      sessionId: "s1",
      toolCallIds: ["t1"],
      activeTools: ACTIVE_TOOLS,
      toolPolicies: { run_terminal_cmd: "allowedWithPermission" },
    });

    expect(policies[0].policy).toBe("allowedWithPermission");
    expect(toolState(store, "t1")?.status).toBe("generated");
  });

  it("never lets dynamic evaluation become more lenient than the base policy", async () => {
    const store = makeStore();
    store.mockIdeMessenger.responseHandlers["tools/evaluatePolicy"] =
      async () => ({
        policy: "allowedWithoutPermission",
        displayValue: undefined,
      });

    const policies = await evaluateSessionToolPolicies(api(store), {
      sessionId: "s1",
      toolCallIds: ["t1"],
      activeTools: ACTIVE_TOOLS,
      toolPolicies: { run_terminal_cmd: "allowedWithPermission" },
    });

    expect(policies[0].policy).toBe("allowedWithPermission");
  });

  it("auto-approves edit tools and ignores unknown tool call ids", async () => {
    const store = createMockStore({
      sessions: {
        activeSessionId: "s1",
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        },
        sessionsById: {
          s1: initialSessionRuntime("s1", "Chat 1", {
            history: [assistant("a1", [toolCall("t1", "edit_existing_file")])],
            pendingApprovalCount: 1,
          }),
        },
      },
    });

    const policies = await evaluateSessionToolPolicies(api(store), {
      sessionId: "s1",
      toolCallIds: ["t1", "missing"],
      activeTools: ACTIVE_TOOLS,
      toolPolicies: {},
    });

    expect(policies).toHaveLength(1);
    expect(policies[0].policy).toBe("allowedWithoutPermission");
  });
});
