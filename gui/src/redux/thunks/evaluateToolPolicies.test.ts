import { describe, expect, it } from "vitest";
import type { Tool, ToolCallState } from "core";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { evaluateSessionToolPolicies } from "./evaluateToolPolicies";

function toolCall(
  toolCallId: string,
  name = "run_terminal_cmd",
  parsedArgs: Record<string, unknown> = { command: "rm -rf /" },
): ToolCallState {
  return {
    toolCallId,
    toolCall: {
      id: toolCallId,
      type: "function",
      function: { name, arguments: "{}" },
    },
    status: "generated",
    parsedArgs,
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

function makeStore(mode: "plan" | "agent" | "agent-full" = "agent") {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    mode,
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

  it("auto-approves edit tools in agent mode and ignores unknown tool call ids", async () => {
    const store = createMockStore({
      sessions: {
        activeSessionId: "s1",
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        },
        sessionsById: {
          s1: initialSessionRuntime("s1", "Chat 1", {
            mode: "agent",
            history: [
              assistant("a1", [
                toolCall("t1", "edit_existing_file", { filepath: "src/a.ts" }),
              ]),
            ],
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

  it("blocks edit tools and mutating shell commands in plan mode while requiring approval for safe read-only shell commands", async () => {
    const store = createMockStore({
      sessions: {
        activeSessionId: "s1",
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        },
        sessionsById: {
          s1: initialSessionRuntime("s1", "Chat 1", {
            mode: "plan",
            history: [
              assistant("a1", [
                toolCall("t-edit", "edit_existing_file", {
                  filepath: "src/a.ts",
                }),
                toolCall("t-find-replace", "single_find_and_replace", {
                  filepath: "src/a.ts",
                }),
                toolCall("t-sort-write", "run_terminal_cmd", {
                  command: "sort -o src/a.ts src/a.ts",
                }),
                toolCall("t-awk", "run_terminal_cmd", {
                  command: "awk 'BEGIN{system(\"id\")}'",
                }),
                toolCall("t-newline", "run_terminal_cmd", {
                  command: "ls -la\nrm -rf /tmp/x",
                }),
                toolCall("t-safe-ls", "run_terminal_cmd", {
                  command: "ls -la",
                }),
              ]),
            ],
            pendingApprovalCount: 6,
          }),
        },
      },
    });
    store.mockIdeMessenger.responseHandlers["tools/evaluatePolicy"] =
      async () => ({
        policy: "allowedWithoutPermission",
        displayValue: undefined,
      });

    const policies = await evaluateSessionToolPolicies(api(store), {
      sessionId: "s1",
      toolCallIds: [
        "t-edit",
        "t-find-replace",
        "t-sort-write",
        "t-awk",
        "t-newline",
        "t-safe-ls",
      ],
      activeTools: ACTIVE_TOOLS,
      toolPolicies: { run_terminal_cmd: "allowedWithoutPermission" },
    });

    expect(policies.map((p) => [p.toolCallState.toolCallId, p.policy])).toEqual(
      [
        ["t-edit", "disabled"],
        ["t-find-replace", "disabled"],
        ["t-sort-write", "disabled"],
        ["t-awk", "disabled"],
        ["t-newline", "disabled"],
        ["t-safe-ls", "allowedWithPermission"],
      ],
    );
    expect(toolState(store, "t-edit")?.status).toBe("errored");
    expect(toolState(store, "t-sort-write")?.status).toBe("errored");
    expect(toolState(store, "t-safe-ls")?.status).toBe("generated");
  });

  it("never lets agent-full override user disabled or dynamic disabled tool policies", async () => {
    const store = createMockStore({
      sessions: {
        activeSessionId: "s1",
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        },
        sessionsById: {
          s1: initialSessionRuntime("s1", "Chat 1", {
            mode: "agent-full",
            history: [
              assistant("a1", [
                toolCall("t-user-disabled", "run_terminal_cmd", {
                  command: "ls",
                }),
                toolCall("t-dyn-disabled", "run_terminal_cmd", {
                  command: "rm -rf /",
                }),
                toolCall("t-upgrade", "run_terminal_cmd", {
                  command: "npm test",
                }),
              ]),
            ],
            pendingApprovalCount: 3,
          }),
        },
      },
    });

    store.mockIdeMessenger.responseHandlers["tools/evaluatePolicy"] = async (
      data: any,
    ) => {
      if (data.parsedArgs?.command === "rm -rf /") {
        return { policy: "disabled", displayValue: "rm -rf /" };
      }
      return { policy: "allowedWithPermission", displayValue: undefined };
    };

    const policiesUserDisabled = await evaluateSessionToolPolicies(api(store), {
      sessionId: "s1",
      toolCallIds: ["t-user-disabled"],
      activeTools: ACTIVE_TOOLS,
      toolPolicies: { run_terminal_cmd: "disabled" },
    });
    expect(policiesUserDisabled[0].policy).toBe("disabled");
    expect(toolState(store, "t-user-disabled")?.status).toBe("errored");

    const policiesDynAndUpgrade = await evaluateSessionToolPolicies(
      api(store),
      {
        sessionId: "s1",
        toolCallIds: ["t-dyn-disabled", "t-upgrade"],
        activeTools: ACTIVE_TOOLS,
        toolPolicies: { run_terminal_cmd: "allowedWithPermission" },
      },
    );
    expect(
      policiesDynAndUpgrade.map((p) => [p.toolCallState.toolCallId, p.policy]),
    ).toEqual([
      ["t-dyn-disabled", "disabled"],
      ["t-upgrade", "allowedWithoutPermission"],
    ]);
    expect(toolState(store, "t-dyn-disabled")?.status).toBe("errored");
  });

  it("handles ResolvedPath objects from create_new_file and mid-path '..' traversal in agent mode", async () => {
    const createInside: ToolCallState = {
      ...toolCall("t-create-in", "create_new_file", {
        filepath: "/workspace/src/new.ts",
      }),
      processedArgs: {
        resolvedPath: {
          uri: "file:///workspace/src/new.ts",
          displayPath: "src/new.ts",
          isWithinWorkspace: true,
        },
      },
    };
    const createOutside: ToolCallState = {
      ...toolCall("t-create-out", "create_new_file", {
        filepath: "sub/../../outside.ts",
      }),
      processedArgs: {
        resolvedPath: {
          uri: "file:///outside.ts",
          displayPath: "/outside.ts",
          isWithinWorkspace: false,
        },
      },
    };
    const editMidTraversal: ToolCallState = toolCall(
      "t-edit-mid",
      "edit_existing_file",
      {
        filepath: "sub/../../outside.ts",
      },
    );
    const store = createMockStore({
      sessions: {
        activeSessionId: "s1",
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        },
        sessionsById: {
          s1: initialSessionRuntime("s1", "Chat 1", {
            mode: "agent",
            history: [
              assistant("a1", [createInside, createOutside, editMidTraversal]),
            ],
            pendingApprovalCount: 3,
          }),
        },
      },
    });
    store.mockIdeMessenger.responseHandlers["tools/evaluatePolicy"] =
      async () => ({
        policy: "allowedWithPermission",
        displayValue: undefined,
      });

    const policies = await evaluateSessionToolPolicies(api(store), {
      sessionId: "s1",
      toolCallIds: ["t-create-in", "t-create-out", "t-edit-mid"],
      activeTools: ACTIVE_TOOLS,
      toolPolicies: {},
    });
    expect(policies.map((p) => [p.toolCallState.toolCallId, p.policy])).toEqual(
      [
        ["t-create-in", "allowedWithPermission"],
        ["t-create-out", "disabled"],
        ["t-edit-mid", "disabled"],
      ],
    );
  });
});
