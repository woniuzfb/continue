import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";
import type { InputModifiers } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { resetSessionSaveQueues } from "./sessionPersistence";
import { resetSessionStreamCheckpoints } from "./sessionStreams";
import { resetSessionStreamRunner } from "./sessionTools";
import { submitSessionInput } from "./sessionSubmit";
import { resolveStreamRetry } from "../../util/streamRetry";
import {
  readSubmitLatencyEvents,
  resetSubmitLatencyEvents,
} from "../../util/submitLatency";
import { approveToolCall } from "./sessionTools";

/**
 * Workflow "submit latency and retry boundary", step 2.
 *
 * The submitted turn must be written **once per user action**. `sessionStreamWrapper`
 * retries its `runStream` closure; that closure used to hold the whole send (editor
 * resolution + turn commit + `USER_SUBMITTED` save), so a single transient model error
 * produced a second user item, a permanently empty assistant placeholder and a third
 * content version. These tests pin that only the model stream is retried.
 */

const EDITOR_STATE: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "hello world" }],
    },
  ],
};

const MODIFIERS: InputModifiers = { useCodebase: false, noContext: true };

function item(
  id: string,
  role: "user" | "assistant",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function makeStore(options: { history?: ChatHistoryItemWithMessageId[] } = {}) {
  const history = options.history ?? [
    item("u1", "user", "earlier"),
    item("a1", "assistant", "sure"),
  ];
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history,
    mode: "agent",
    chatModelTitle: "gpt-4o",
    persistence: {
      state: "clean",
      revision: 0,
      persistedRevision: 0,
      hasPersistedBaseline: false,
    },
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

const session = (store: ReturnType<typeof makeStore>) =>
  (store.getState() as any).sessions.sessionsById.s1;

const run = (store: ReturnType<typeof makeStore>, thunk: any) =>
  (store.dispatch(thunk) as any).unwrap() as Promise<any>;

/** Answers the retry dialog as soon as the wrapper opens it. */
function autoAnswerRetry(
  store: ReturnType<typeof makeStore>,
  choice: "retry" | "disconnect",
) {
  const timer = setInterval(() => {
    if ((store.getState() as any).ui.showDialog) {
      resolveStreamRetry(choice);
    }
  }, 10);
  return () => clearInterval(timer);
}

function submittedUserCount(store: ReturnType<typeof makeStore>) {
  return session(store).history.filter(
    (entry: any) => entry.message.role === "user",
  ).length;
}

/**
 * A **dangling** placeholder: the turn ends with an assistant item that never received
 * content. (An assistant item with empty content in the middle is legitimate — that is
 * how a tool call is carried.)
 */
function endsWithDanglingPlaceholder(store: ReturnType<typeof makeStore>) {
  const last = session(store).history.at(-1);
  return (
    last?.message.role === "assistant" &&
    (last.message.content === "" || last.message.content === undefined)
  );
}

/** `history/save` payloads seen by a spy that was installed **before** the send. */
function savePayloads(request: { mock: { calls: any[][] } }) {
  return request.mock.calls
    .filter(([type]: any[]) => type === "history/save")
    .map(([, payload]: any[]) => payload);
}

describe("submit retry boundary — a transient error must not resubmit the turn", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
    resetSubmitLatencyEvents();
  });

  it("retries only the model stream: one user turn, one placeholder, one save", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    let attempts = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      attempts++;
      if (attempts === 1) {
        throw new Error("socket hang up");
      }
      yield [{ role: "assistant", content: "recovered" } as any];
    } as any;
    const revisionBefore = session(store).conversationRevision;

    const stopAnswering = autoAnswerRetry(store, "retry");
    const outcome = await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    stopAnswering();

    expect(outcome).toBe(true);
    expect(attempts).toBe(2);

    // Exactly one submitted turn, and the second attempt wrote into **its** placeholder.
    expect(submittedUserCount(store)).toBe(2); // the pre-existing "earlier" + this one
    const roles = session(store).history.map(
      (entry: any) => entry.message.role,
    );
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    expect(session(store).history.at(-1).message.content).toBe("recovered");
    // No dangling placeholder is left behind.
    expect(endsWithDanglingPlaceholder(store)).toBe(false);

    // …and the retry did not add a content version of its own: submit + terminal.
    expect(session(store).conversationRevision).toBe(revisionBefore + 2);

    // Whatever saves this send produced (the USER_SUBMITTED boundary, the aborted-request
    // bookkeeping the retry triggers, the terminal save), **none** of them may carry a
    // second submitted turn: four items, two users, always.
    const payloads = savePayloads(request as any);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads as any[]) {
      expect(payload.history).toHaveLength(4);
      expect(
        payload.history.filter((entry: any) => entry.message.role === "user"),
      ).toHaveLength(2);
    }
    // Exactly one terminal save carries a measurement; the retry did not add another.
    expect(
      payloads.filter(
        (payload: any) => payload.fullConversationMeasurement !== undefined,
      ),
    ).toHaveLength(1);
  });

  it("does not resolve the editor or gather context twice", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    let attempts = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      attempts++;
      if (attempts === 1) {
        throw new Error("socket hang up");
      }
      yield [{ role: "assistant", content: "recovered" } as any];
    } as any;

    const stopAnswering = autoAnswerRetry(store, "retry");
    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    stopAnswering();

    // One `history/save` per boundary, and — the point — only one preparation ran, so the
    // latency phases for editor/context work appear once per send.
    const editorPhases = latencyPhases();
    expect(editorPhases.filter((p) => p === "editor-processing")).toHaveLength(
      1,
    );
    expect(editorPhases.filter((p) => p === "context-resolution")).toHaveLength(
      1,
    );
    expect(editorPhases.filter((p) => p === "commit-turn")).toHaveLength(1);
    // The stream itself really did start twice.
    expect(editorPhases.filter((p) => p === "stream-start")).toHaveLength(2);
  });

  it("keeps the retry boundary for an edit/resend (replace)", async () => {
    const store = makeStore({
      history: [
        item("u1", "user", "first"),
        item("a1", "assistant", "answer"),
        item("u2", "user", "second"),
        item("a2", "assistant", "answer 2"),
      ],
    });
    let attempts = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      attempts++;
      if (attempts === 1) {
        throw new Error("socket hang up");
      }
      yield [{ role: "assistant", content: "recovered" } as any];
    } as any;
    const revisionBefore = session(store).conversationRevision;

    const stopAnswering = autoAnswerRetry(store, "retry");
    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        targetMessageId: "u2",
      }),
    );
    stopAnswering();

    // The replaced turn is still a single user turn at the same position.
    const ids = session(store).history.map((entry: any) => entry.message.id);
    expect(ids.slice(0, 2)).toEqual(["u1", "a1"]);
    expect(ids).toHaveLength(4);
    expect(session(store).history.at(-1).message.content).toBe("recovered");
    expect(endsWithDanglingPlaceholder(store)).toBe(false);
    expect(session(store).conversationRevision).toBe(revisionBefore + 2);
  });

  it("stops at the first failure when the user declines the retry", async () => {
    const store = makeStore();
    let attempts = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      attempts++;
      throw new Error("socket hang up");
    } as any;
    const revisionAfterSubmitOnly = session(store).conversationRevision + 1;

    const stopAnswering = autoAnswerRetry(store, "disconnect");
    const outcome = await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    stopAnswering();

    expect(outcome).toBe(false);
    expect(attempts).toBe(1);
    // The submit still counts as one version; the failed stream adds nothing.
    expect(session(store).conversationRevision).toBe(revisionAfterSubmitOnly);
    expect(submittedUserCount(store)).toBe(2);
  });

  it("reports a permanent failure after the retry also fails, without resubmitting", async () => {
    const store = makeStore();
    let attempts = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      attempts++;
      throw new Error("provider rejected the request");
    } as any;
    const revisionBefore = session(store).conversationRevision;

    const outcome = await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );

    expect(outcome).toBe(false);
    expect(attempts).toBe(1);
    expect(submittedUserCount(store)).toBe(2);
    expect(session(store).conversationRevision).toBe(revisionBefore + 1);
    expect((store.getState() as any).ui.showDialog).toBe(true);
  });

  it("does not submit anything when preparation fails after the submit boundary", async () => {
    // The target identity disappears while the editor content resolves: the submit is
    // refused before the stream, and the retry boundary never sees it.
    const store = makeStore({
      history: [
        item("u1", "user", "first"),
        item("a1", "assistant", "answer"),
        item("u2", "user", "second"),
        item("a2", "assistant", "answer 2"),
      ],
    });
    let attempts = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      attempts++;
      yield [{ role: "assistant", content: "should not run" } as any];
    } as any;
    // A stale target id: never present, so preparation refuses the send.
    const outcome = await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        targetMessageId: "does-not-exist",
      }),
    );

    expect(outcome).toBe(false);
    expect(attempts).toBe(0);
    expect(submittedUserCount(store)).toBe(2);
    expect((store.getState() as any).ui.showDialog).toBe(true);
  });

  it("keeps one placeholder across a tool loop", async () => {
    // A tool call pauses the turn; the continuation writes into the same placeholder.
    // Submit +1, tool writes +0, terminal +1.
    const store = makeStore();
    let turn = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      turn++;
      yield turn === 1
        ? [
            {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "t1",
                  type: "function",
                  function: { name: "run_terminal_cmd", arguments: "{}" },
                },
              ],
            } as any,
          ]
        : [{ role: "assistant", content: "all tests pass" } as any];
    } as any;
    const revisionBefore = session(store).conversationRevision;

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    await vi.waitFor(() => {
      expect(session(store).pendingApprovalCount).toBe(1);
    });
    await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: session(store).stream.requestId,
        toolCallId: "t1",
      }),
    );
    await pending;
    await vi.waitFor(() => {
      expect(session(store).stream).toEqual({ status: "idle" });
    });

    expect(turn).toBe(2);
    expect(submittedUserCount(store)).toBe(2);
    expect(session(store).history.at(-1).message.content).toBe(
      "all tests pass",
    );
    expect(endsWithDanglingPlaceholder(store)).toBe(false);
    expect(session(store).conversationRevision).toBe(revisionBefore + 2);
  });

  it("cannot duplicate the turn when a tool continuation fails", async () => {
    // A continuation failure surfaces on the continuation's own chain, not through the
    // wrapper's retry — and either way it can no longer re-submit the turn, because the
    // submit is committed before any stream starts.
    const store = makeStore();
    let turn = 0;
    store.mockIdeMessenger.llmStreamChat = async function* () {
      turn++;
      if (turn === 1) {
        yield [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "t1",
                type: "function",
                function: { name: "run_terminal_cmd", arguments: "{}" },
              },
            ],
          } as any,
        ];
        return;
      }
      throw new Error("provider failed after the tool result");
    } as any;
    const revisionBefore = session(store).conversationRevision;

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    await vi.waitFor(() => {
      expect(session(store).pendingApprovalCount).toBe(1);
    });
    await run(
      store,
      approveToolCall({
        sessionId: "s1",
        requestId: session(store).stream.requestId,
        toolCallId: "t1",
      }),
    );
    await pending;
    await vi.waitFor(() => {
      expect(session(store).stream.status).toBe("failed");
    });

    // One submitted turn, whatever the continuation did. The tool call and its result are
    // real content, so the failed continuation still contributes exactly one version for
    // the whole logical turn: submit +1, turn +1.
    expect(submittedUserCount(store)).toBe(2);
    expect(session(store).conversationRevision).toBe(revisionBefore + 2);
  });
});

function latencyPhases(): string[] {
  return readSubmitLatencyEvents().map((event) => event.phase);
}
