import { describe, expect, it } from "vitest";
import type { ModelDescription, ToolCallState } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { selectSessionChatModel } from "./sessions";
import {
  selectSessionFirstPendingToolCall,
  selectSessionHasToolCalls,
  selectSessionPendingToolCalls,
  selectSessionToolCallById,
  selectSessionToolCalls,
  selectSessionToolCallsByStatus,
} from "./sessionToolCalls";

function toolCall(
  toolCallId: string,
  status: ToolCallState["status"] = "generated",
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
  toolCallStates?: ToolCallState[],
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

const CHAT_MODEL = {
  title: "gpt-4o",
  provider: "openai",
  model: "gpt-4o",
} as ModelDescription;

function makeStore() {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [
      user("u1"),
      assistant("a1", [toolCall("t1", "done"), toolCall("t2")]),
    ],
    chatModelTitle: "gpt-4o",
  });
  const s2 = initialSessionRuntime("s2", "Chat 2", {
    history: [user("u2"), assistant("a2", [toolCall("other")])],
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
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat: [CHAT_MODEL],
        },
      },
    },
  });
}

describe("session-scoped tool call selectors", () => {
  it("reads tool calls of the requested session, not the active one", () => {
    const store = makeStore();
    const state = store.getState() as any;

    expect(
      selectSessionToolCalls(state, "s1").map((tc) => tc.toolCallId),
    ).toEqual(["t1", "t2"]);
    expect(
      selectSessionToolCalls(state, "s2").map((tc) => tc.toolCallId),
    ).toEqual(["other"]);
  });

  it("filters by status and pending calls", () => {
    const store = makeStore();
    const state = store.getState() as any;

    expect(
      selectSessionToolCallsByStatus(state, "s1", "generated").map(
        (tc) => tc.toolCallId,
      ),
    ).toEqual(["t2"]);
    expect(
      selectSessionPendingToolCalls(state, "s1").map((tc) => tc.toolCallId),
    ).toEqual(["t2"]);
    expect(selectSessionFirstPendingToolCall(state, "s1")?.toolCallId).toBe(
      "t2",
    );
    expect(selectSessionHasToolCalls(state, "s1")).toBe(true);
  });

  it("looks up a tool call by id inside the requested session", () => {
    const store = makeStore();
    const state = store.getState() as any;

    expect(selectSessionToolCallById(state, "s1", "t1")?.status).toBe("done");
    // `other` lives in s2 only.
    expect(selectSessionToolCallById(state, "s1", "other")).toBeUndefined();
  });

  it("returns empty results for an unknown session", () => {
    const store = makeStore();
    const state = store.getState() as any;

    expect(selectSessionToolCalls(state, "nope")).toEqual([]);
    expect(selectSessionHasToolCalls(state, "nope")).toBe(false);
    expect(selectSessionFirstPendingToolCall(state, "nope")).toBeUndefined();
  });
});

describe("selectSessionChatModel", () => {
  it("resolves the session's own model title", () => {
    const store = makeStore();
    expect(selectSessionChatModel(store.getState() as any, "s1")?.title).toBe(
      "gpt-4o",
    );
  });

  it("falls back to the persisted user choice, never the active projection", () => {
    const store = makeStore();
    store.dispatch({
      type: "config/setActiveSessionModelProjection",
      payload: {
        model: { title: "active-only", provider: "x", model: "x" },
      },
    });

    const state = store.getState() as any;
    expect(selectSessionChatModel(state, "s2")?.title).not.toBe("active-only");
    expect(selectSessionChatModel(state, "nope")).toBeUndefined();
  });
});
