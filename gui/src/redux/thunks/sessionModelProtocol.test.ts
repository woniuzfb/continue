import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelDescription, Tool } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import {
  resetSessionStreamCheckpoints,
  runSessionStream,
} from "./sessionStreams";
import { submitSessionInput } from "./sessionSubmit";
import { approveToolCall, resetSessionStreamRunner } from "./sessionTools";

/**
 * 方案.md §7.5.4 — the protocol that removes "显示 A、实际发 B".
 *
 * The acceptance criterion of this contract is an **equality chain**:
 *
 *     UI 显示的 ref = turn 开始捕获的 ref = GUI compile 使用的 ref = Core 最终解析并调用的 ref
 *
 * Every step of that chain must be provable, and where it cannot be (a ref matching zero or several
 * entries) the send has to be refused. This file proves the GUI half: that both requests of one turn
 * carry the *same* identity, and that the identity is fixed when the turn starts — a model switch
 * afterwards (while an approval bar is up) must not move the turn to another model.
 *
 * One note on the harness: `llm/streamChat` does not travel through `ideMessenger.request` (it is a
 * streaming call), so the stream side's payload is captured by wrapping `llmStreamChat` itself
 * instead of by spying on `request`.
 */

const GPT = {
  title: "gpt-4o",
  provider: "openai",
  model: "gpt-4o",
  underlyingProviderName: "openai",
} as ModelDescription;

/** A second entry sharing `GPT`'s title: only the ref can tell the two apart. */
const GPT_ANTHROPIC = {
  title: "gpt-4o",
  provider: "anthropic",
  model: "gpt-4o",
  underlyingProviderName: "anthropic",
} as ModelDescription;

const CLAUDE = {
  title: "claude",
  provider: "anthropic",
  model: "claude-sonnet",
  underlyingProviderName: "anthropic",
} as ModelDescription;

const TOOL: Tool = {
  type: "function",
  function: { name: "run_terminal_cmd", description: "run a command" },
  displayTitle: "Run command",
  wouldLikeTo: "run a command",
  readonly: false,
  group: "built-in",
};

type StoreOptions = {
  models?: ModelDescription[];
  chatModelTitle?: string;
  chatModelRef?: { title: string; provider: string; model: string };
  /** A session with a legacy title only: no ref at all. */
  withoutRef?: boolean;
  history?: ChatHistoryItemWithMessageId[];
};

function user(id: string, content = "hi"): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role: "user",
      content,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function session(store: ReturnType<typeof makeStore>) {
  return (store.getState() as any).sessions.sessionsById.s1;
}

function makeStore(options: StoreOptions = {}) {
  const {
    models = [GPT, CLAUDE],
    chatModelTitle = "gpt-4o",
    chatModelRef = { title: "gpt-4o", provider: "openai", model: "gpt-4o" },
    withoutRef = false,
    history = [user("u1")],
  } = options;

  const runtime = initialSessionRuntime("s1", "Chat 1", {
    history,
    mode: "agent",
    chatModelTitle,
    ...(withoutRef ? {} : { chatModelRef }),
    stream: { status: "idle" },
  });

  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1: runtime },
    },
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        tools: [TOOL],
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat: models,
        },
      },
    },
  });
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

function toolCallChunk(toolCallId = "t1"): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: toolCallId,
        type: "function",
        function: { name: "run_terminal_cmd", arguments: '{"command":"ls"}' },
      },
    ],
  } as any;
}

function textChunk(text: string): ChatMessage {
  return { role: "assistant", content: text } as ChatMessage;
}

/**
 * The `modelRef` of every `llm/compileChat` request, in order. Read off the recorded calls (a typed
 * `filter` fights the spy's tuple types for no benefit — the message type is all that is matched).
 */
function compileRefs(request: { mock: { calls: any[][] } }): unknown[] {
  return request.mock.calls
    .filter((entry) => entry[0] === "llm/compileChat")
    .map((entry) => entry[1]?.modelRef);
}

/** Every `modelRef` (and `title`) that reached `llm/streamChat`, in order. */
type StreamedPayload = { modelRef?: unknown; title?: string };

/**
 * Replaces the stream with `scenario(payload, callIndex)` while recording the payload of every call,
 * so a test can assert on what each **request** carried rather than on what the generator returned.
 *
 * The generator returns a non-empty `PromptLog`, because that return value is what the send path
 * turns into the interaction telemetry (`devdata/log`) — a generator that returns nothing produces no
 * telemetry at all.
 */
function captureStream(
  store: ReturnType<typeof makeStore>,
  scenario: (payload: StreamedPayload, call: number) => ChatMessage[],
): StreamedPayload[] {
  const payloads: StreamedPayload[] = [];
  store.mockIdeMessenger.llmStreamChat = async function* (payload: any) {
    payloads.push({ modelRef: payload?.modelRef, title: payload?.title });
    for (const message of scenario(payload, payloads.length)) {
      yield [message];
    }
    return {
      modelTitle: payload?.title,
      modelProvider: payload?.title,
      prompt: "prompt text",
      completion: "completion text",
      completionOptions: {},
    };
  } as any;
  return payloads;
}

describe("one turn carries one model ref through compile and stream (方案.md §7.5.4)", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  it("sends the same ref to compileChat and to streamChat", async () => {
    const store = makeStore();
    const streamed = captureStream(store, () => [textChunk("done")]);
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));

    const compiled = compileRefs(request);
    expect(compiled).toHaveLength(1);
    expect(streamed).toHaveLength(1);
    // The GUI half of the equality chain: both requests state the identity the turn captured.
    expect(streamed[0].modelRef).toEqual(compiled[0]);
    expect(compiled[0]).toEqual({
      title: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("identifies the chosen entry by ref when two entries share its title", async () => {
    // The user picked the *anthropic* `gpt-4o`. A title-only request cannot say that, and Core must
    // not be left to guess between the two entries.
    const store = makeStore({
      models: [GPT, GPT_ANTHROPIC],
      chatModelRef: { title: "gpt-4o", provider: "anthropic", model: "gpt-4o" },
    });
    const streamed = captureStream(store, () => [textChunk("done")]);

    await run(store, runSessionStream({ sessionId: "s1" }));

    expect(streamed[0].modelRef).toEqual({
      title: "gpt-4o",
      provider: "anthropic",
      model: "gpt-4o",
    });
  });

  it("never calls the model when the session's ref cannot be resolved", async () => {
    // The session points at a model the config no longer has: no compile, no stream — and above all
    // no silent fallback to whichever model is selected.
    const store = makeStore({
      models: [CLAUDE],
      chatModelRef: { title: "gpt-4o", provider: "openai", model: "gpt-4o" },
    });
    const streamed = captureStream(store, () => [
      textChunk("should not happen"),
    ]);
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(store, runSessionStream({ sessionId: "s1" }));

    expect(request).not.toHaveBeenCalledWith(
      "llm/compileChat",
      expect.anything(),
    );
    expect(streamed).toHaveLength(0);
    expect(session(store).stream.error).toBe("No chat model selected");
  });

  it("keeps the turn's ref when the session's model is switched mid-turn", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const streamed = captureStream(store, () => {
      // While the request is in flight the user picks another model for this window.
      store.dispatch({
        type: "sessions/setSessionChatModelTitle",
        payload: {
          sessionId: "s1",
          chatModelTitle: "claude",
          chatModelRef: {
            title: "claude",
            provider: "anthropic",
            model: "claude-sonnet",
          },
        },
      });
      return [textChunk("done")];
    });

    await run(store, runSessionStream({ sessionId: "s1" }));

    // The session owns the new model…
    expect(session(store).chatModelRef.provider).toBe("anthropic");
    // …while everything this turn sent still names the model it started with.
    const compiled = compileRefs(request);
    expect(compiled[0]).toEqual({
      title: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
    });
    expect(streamed[0].modelRef).toEqual({
      title: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("agrees on the ref across a retried attempt after a transient error", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const streamed = captureStream(store, (_payload, call) => {
      if (call === 1) {
        throw new Error("premature close");
      }
      return [textChunk("recovered")];
    });

    await run(store, runSessionStream({ sessionId: "s1" })).catch(() => {});
    // A retry is a fresh logical turn, so it may legitimately pick up a new choice — the invariant
    // is that *within* one attempt compile and stream state the same identity.
    store.dispatch({
      type: "sessions/setSessionChatModelTitle",
      payload: {
        sessionId: "s1",
        chatModelTitle: "claude",
        chatModelRef: {
          title: "claude",
          provider: "anthropic",
          model: "claude-sonnet",
        },
      },
    });
    await run(store, runSessionStream({ sessionId: "s1" }));

    const compiled = compileRefs(request);
    expect(compiled).toHaveLength(2);
    expect(streamed).toHaveLength(2);
    expect(compiled[0]).toEqual(streamed[0].modelRef);
    expect(compiled[1]).toEqual(streamed[1].modelRef);
    expect(streamed[1].modelRef).toEqual({
      title: "claude",
      provider: "anthropic",
      model: "claude-sonnet",
    });
  });

  it("keeps the turn's ref across a tool-loop continuation after a mid-turn switch", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const streamed = captureStream(store, (_payload, call) =>
      call === 1 ? [toolCallChunk()] : [textChunk("all tests pass")],
    );

    await run(store, runSessionStream({ sessionId: "s1" }));
    const requestId = session(store).stream.requestId;
    // The approval bar is up: the request is paused, not finished.
    expect(session(store).pendingApprovalCount).toBe(1);
    // The user picks another model while the turn waits for approval.
    store.dispatch({
      type: "sessions/setSessionChatModelTitle",
      payload: {
        sessionId: "s1",
        chatModelTitle: "claude",
        chatModelRef: {
          title: "claude",
          provider: "anthropic",
          model: "claude-sonnet",
        },
      },
    });

    await run(
      store,
      approveToolCall({ sessionId: "s1", requestId, toolCallId: "t1" }),
    );

    // The continuation is the *same logical turn*: it must still name the model the turn started
    // with. Re-resolving here is how a model switch while the approval bar is up would silently
    // change the model that answers the tool result.
    expect(streamed).toHaveLength(2);
    expect(streamed[1].modelRef).toEqual(streamed[0].modelRef);
    expect(streamed[1].modelRef).toEqual({
      title: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
    });
    // …and the continuation's own compile agrees with it.
    const compiled = compileRefs(request);
    expect(compiled).toHaveLength(2);
    expect(compiled[1]).toEqual(streamed[1].modelRef);
  });

  it("refuses to submit a legacy session whose title names several entries", async () => {
    // Contract §7.5.4: a legacy title that cannot be upgraded stays **unresolved**, and the user's
    // send is refused — the alternative is picking one of two entries for them, which is exactly the
    // "显示 A、实际发 B" report this contract exists to remove. Nothing reaches the model here: the
    // refusal happens before the placeholder is even committed.
    const store = makeStore({
      models: [GPT, GPT_ANTHROPIC],
      chatModelTitle: "gpt-4o",
      withoutRef: true,
      history: [user("u1")],
    });
    const streamed = captureStream(store, () => [
      textChunk("should not happen"),
    ]);

    const sent = await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "hi" }] },
          ],
        } as any,
        modifiers: { useCodebase: false, noContext: true },
      }),
    );

    // A refused send reports the failure to the user (the error dialog) and resolves `false` — the
    // caller `unwrap()`s, so it must never reject — and nothing reaches a model.
    expect(sent).toBe(false);
    expect((store.getState() as any).ui.showDialog).toBe(true);
    expect(streamed).toHaveLength(0);
    // The session keeps its own (unusable) choice rather than being rewritten to another model.
    expect(session(store).chatModelTitle).toBe("gpt-4o");
    expect(session(store).chatModelRef).toBeUndefined();
  });

  it("logs the same identity the request carried, and nothing else about the model", async () => {
    // Contract item 14: the logs name the same identity as the request, and carry no key, endpoint
    // or prompt. A log that disagreed with the request would make the very bug this contract fixes
    // invisible in telemetry.
    const store = makeStore();
    const posted: any[] = [];
    const originalPost = store.mockIdeMessenger.post.bind(
      store.mockIdeMessenger,
    );
    store.mockIdeMessenger.post = ((type: string, data: any) => {
      if (type === "devdata/log") {
        posted.push(data);
        return;
      }
      return originalPost(type as any, data as any);
    }) as any;
    captureStream(store, () => [textChunk("done")]);

    await run(store, runSessionStream({ sessionId: "s1" }));

    const interaction = posted.find(
      (entry) => entry?.name === "chatInteraction",
    );
    expect(interaction).toBeDefined();
    expect(interaction.data.modelName).toBe("gpt-4o");
    expect(interaction.data.modelProvider).toBe("openai");
    expect(interaction.data.modelTitle).toBe("gpt-4o");
    expect(JSON.stringify(interaction.data)).not.toMatch(
      /apiKey|apiBase|https?:\/\//,
    );
  });
});
