import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";
import type { ChatMessage, InputModifiers, Session, Tool } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { bootstrapLastSession } from "./sessionLifecycle";
import { resetSessionSaveQueues } from "./sessionPersistence";
import { resetSessionStreamCheckpoints } from "./sessionStreams";
import { approveToolCall, resetSessionStreamRunner } from "./sessionTools";
import { submitSessionInput } from "./sessionSubmit";

/**
 * End-to-end check of the Phase 1 session architecture, driven only through
 * `sessionsById`: catalog bootstrap -> disk load -> submit -> stream -> tool
 * approval -> loop continuation -> terminal save. It is the regression net the
 * consumer switch needs, because the app still runs the legacy path today.
 */

const EDITOR_STATE: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "run the tests" }] },
  ],
};

const MODIFIERS: InputModifiers = { useCodebase: false, noContext: true };

const TOOL: Tool = {
  type: "function",
  function: { name: "run_terminal_cmd", description: "run a command" },
  displayTitle: "Run command",
  wouldLikeTo: "run a command",
  readonly: false,
  group: "built-in",
};

function item(
  id: string,
  role: "user" | "assistant",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role,
      content,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function diskSession(): Session {
  return {
    sessionId: "s1",
    title: "Disk chat",
    workspaceDirectory: "/w",
    mode: "agent",
    chatModelTitle: "gpt-4o",
    history: [item("d1", "user", "earlier"), item("d2", "assistant", "ok")],
  } as Session;
}

function toolCallChunk(): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "t1",
        type: "function",
        function: { name: "run_terminal_cmd", arguments: '{"command":"ls"}' },
      },
    ],
  } as any;
}

function makeStore() {
  const store = createMockStore({
    sessions: {
      activeSessionId: undefined,
      tabOrder: [],
      tabDescriptors: {},
      sessionsById: {},
    },
    sessionCatalog: {
      allSessionMetadata: [
        {
          sessionId: "s1",
          title: "Disk chat",
          dateCreated: "2026-01-01T00:00:00.000Z",
          workspaceDirectory: "/w",
        },
      ],
      lastSessionId: "s1",
      isLoading: false,
    },
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        tools: [TOOL],
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat: [
            {
              title: "gpt-4o",
              provider: "openai",
              model: "gpt-4o",
            } as any,
          ],
        },
      },
    },
  });
  store.mockIdeMessenger.responses["history/load"] = diskSession();
  store.mockIdeMessenger.responses["history/delete"] = undefined;
  return store;
}

function session(store: ReturnType<typeof makeStore>) {
  return (store.getState() as any).sessions.sessionsById["s1"];
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("session architecture end to end", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  it("bootstraps from disk, submits, approves a tool and finishes the turn", async () => {
    const store = makeStore();
    let turn = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      turn++;
      yield turn === 1
        ? [toolCallChunk()]
        : [{ role: "assistant", content: "all tests pass" } as ChatMessage];
    } as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    // 1. Startup: catalog -> descriptor -> runtime from disk -> active.
    await run(store, bootstrapLastSession());
    expect((store.getState() as any).sessions.activeSessionId).toBe("s1");
    expect(session(store).history).toHaveLength(2);

    // 2. Submit: user message + placeholder, then the model asks for a tool.
    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );

    const afterSubmit = session(store);
    expect(afterSubmit.history).toHaveLength(4);
    expect(afterSubmit.history[2].message.role).toBe("user");
    expect(afterSubmit.pendingApprovalCount).toBe(1);
    expect(afterSubmit.stream.status).toBe("streaming");
    const requestId = afterSubmit.stream.requestId;
    expect(typeof requestId).toBe("string");
    expect(request).not.toHaveBeenCalledWith("tools/call", expect.anything());

    // 3. Approve: the tool runs, its result is recorded and the loop continues.
    const outcome = await run(
      store,
      approveToolCall({ sessionId: "s1", requestId, toolCallId: "t1" }),
    );
    expect(outcome).toMatchObject({ status: "approved" });
    expect(request).toHaveBeenCalledWith("tools/call", expect.anything());

    await vi.waitFor(() => {
      expect(session(store).stream).toEqual({ status: "idle" });
    });

    const final = session(store);
    const roles = final.history.map((entry: any) => entry.message.role);
    expect(roles).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(final.history.at(-1).message.content).toBe("all tests pass");
    expect(
      final.history
        .flatMap((entry: any) => entry.toolCallStates ?? [])
        .find((state: any) => state.toolCallId === "t1").status,
    ).toBe("done");
    expect(final.pendingApprovalCount).toBe(0);
    expect(final.persistence?.state).toBe("clean");
    expect(final.dirty).toBe(false);
    expect(turn).toBe(2);

    // Terminal save went to disk for the right session.
    expect(request).toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({ sessionId: "s1" }),
    );
  });
});
