import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallState } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import {
  dismissInterruptedSession,
  hasUnresumableTurn,
  retryInterruptedSession,
} from "./sessionInterruption";
import { resetSessionStreamCheckpoints } from "./sessionStreams";
import { resetSessionStreamRunner } from "./sessionTools";

function toolCall(
  toolCallId: string,
  status: ToolCallState["status"],
): ToolCallState {
  return {
    toolCallId,
    toolCall: {
      id: toolCallId,
      type: "function",
      function: { name: "run_terminal_cmd", arguments: "{}" },
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

function user(id: string): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role: "user",
      content: "go",
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function makeStore(status: ToolCallState["status"]) {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [user("u1"), assistant("a1", [toolCall("t1", status)])],
    interrupted: true,
    mode: "agent",
    chatModelTitle: "gpt-4o",
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
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat: [
            { title: "gpt-4o", provider: "openai", model: "gpt-4o" } as any,
          ],
        },
      },
    },
  });
}

function session(store: ReturnType<typeof makeStore>) {
  return (store.getState() as any).sessions.sessionsById["s1"];
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("interrupted sessions", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  it("detects a turn with non-terminal tool calls", () => {
    expect(
      hasUnresumableTurn([
        user("u1"),
        assistant("a1", [toolCall("t1", "calling")]),
      ]),
    ).toBe(true);
    expect(
      hasUnresumableTurn([
        user("u1"),
        assistant("a1", [toolCall("t1", "done")]),
      ]),
    ).toBe(false);
  });

  it("dismiss closes the stale calls and clears the flag", async () => {
    const store = makeStore("calling");
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, dismissInterruptedSession({ sessionId: "s1" }));

    expect(session(store).interrupted).toBe(false);
    expect(
      session(store)
        .history.flatMap((item: any) => item.toolCallStates ?? [])
        .at(0).status,
    ).toBe("canceled");
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "history/save",
        expect.objectContaining({ sessionId: "s1" }),
      );
    });
  });

  it("retry supersedes the stale calls and starts a fresh request", async () => {
    const store = makeStore("calling");
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const before = session(store).conversationRevision;

    await run(store, retryInterruptedSession({ sessionId: "s1" }));

    // Stage 2F acceptance #8: a retry writes **no new turn structure**. The only
    // content version so far is canceling the stale tool calls — a real content change
    // made outside any live turn (`setSessionInterrupted` itself is not content).
    // Whatever the resumed turn writes stays inside that live turn until its own
    // terminal commit, so a retry can never double-count a submitted turn; in this
    // fixture the resumed request is still waiting for a tool call, so no terminal has
    // happened yet.
    expect(session(store).conversationRevision).toBe(before + 1);
    expect(
      session(store).history.filter(
        (entry: any) => entry.message.role === "user",
      ),
    ).toHaveLength(1);
    expect(session(store).interrupted).toBe(false);
    expect(request).toHaveBeenCalledWith("llm/compileChat", expect.anything());
    // The stale call no longer blocks a new turn.
    expect(
      session(store)
        .history.flatMap((item: any) => item.toolCallStates ?? [])
        .at(0).status,
    ).toBe("canceled");
  });
});
