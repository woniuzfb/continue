import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallState } from "core";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionCodeBlockApplyIndex } from "../slices/sessionsSlice";
import {
  applySessionForEditTool,
  handleSessionApplyStateUpdate,
  lookupApplyOrigin,
  resetApplyOrigins,
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
      sessionId: "s1",
      toolCallId: "t1",
    });
    expect(session(store).codeBlockApplyStates.states).toEqual([
      { streamId: "stream-1", toolCallId: "t1", status: "not-started" },
    ]);
    expect(request).toHaveBeenCalledWith(
      "applyToFile",
      expect.objectContaining({ streamId: "stream-1" }),
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
