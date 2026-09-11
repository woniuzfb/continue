import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";
import type { InputModifiers } from "core";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import {
  flushAllPendingSessions,
  resetSessionSaveQueues,
} from "./sessionPersistence";
import { resetSessionStreamCheckpoints } from "./sessionStreams";
import { resetSessionStreamRunner } from "./sessionTools";
import { submitSessionInput } from "./sessionSubmit";
import {
  clearPendingSubmission,
  markSessionDirty,
  setPendingSubmission,
} from "../slices/sessionsSlice";
import {
  pendingSubmissionTargetIndex,
  pendingSubmissionText,
} from "../util/pendingSubmission";

/**
 * Workflow "submit latency and retry boundary", step 3: the pending draft.
 *
 * Stage 2F commits the submitted turn only after the editor content is resolved, and that
 * resolution awaits context IPC — so the bubble appeared about a second after Enter. The
 * draft is the feedback for that window, and it must be **presentation only**: not in
 * history, not in the save payload, not in the metrics or the content revision.
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

/** Holds the context IPC open so the pending window can be inspected. */
function holdContextRequest(store: ReturnType<typeof makeStore>) {
  let release: ((value: any) => void) | undefined;
  let requested = false;
  const request = vi.spyOn(store.mockIdeMessenger, "request");
  request.mockImplementation(((type: string) => {
    if (type === "context/getContextItems") {
      requested = true;
      return new Promise((resolve) => {
        release = () => resolve({ status: "success", content: [], done: true });
      });
    }
    return Promise.resolve({ status: "success", content: {}, done: true });
  }) as any);
  return {
    request,
    async contextRequested() {
      await vi.waitFor(() => expect(requested).toBe(true));
    },
    release() {
      release?.(undefined);
    },
  };
}

describe("pending submission draft — shown while the turn is prepared", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  it("appears before the awaited context resolution finishes", async () => {
    const store = makeStore();
    const gate = holdContextRequest(store);
    const revisionBefore = session(store).conversationRevision;

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: { useCodebase: false, noContext: false },
      }),
    );
    await gate.contextRequested();

    // The draft is visible while the send is still resolving, and nothing else moved:
    // no history item, no content revision, no dirty state.
    const draft = session(store).pendingSubmission;
    expect(draft).toBeDefined();
    expect(draft.insertion).toEqual({ kind: "append" });
    expect(pendingSubmissionText(draft)).toContain("hello world");
    expect(session(store).history).toHaveLength(2);
    expect(session(store).conversationRevision).toBe(revisionBefore);
    expect(pendingTargetIndexFor(store)).toBe(-1);

    gate.release();
    await pending;

    // Once the turn is committed the draft is gone — the real bubble replaced it.
    expect(session(store).pendingSubmission).toBeUndefined();
    expect(session(store).history).toHaveLength(4);
    expect(session(store).conversationRevision).toBe(revisionBefore + 2);
  });

  it("never reaches the save payload, the metrics or the content revision", async () => {
    const store = makeStore();
    const gate = holdContextRequest(store);

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: { useCodebase: false, noContext: false },
      }),
    );
    await gate.contextRequested();
    // A save that happens **while the draft is visible** must not see it: make the session
    // dirty and run the real flush boundary.
    store.dispatch(markSessionDirty({ sessionId: "s1" }));
    await run(store, flushAllPendingSessions());
    expect(session(store).pendingSubmission).toBeDefined();
    const payloads = gate.request.mock.calls
      .filter(([type]: any[]) => type === "history/save")
      .map(([, payload]: any[]) => payload);
    for (const payload of payloads) {
      expect(payload.history).toHaveLength(2);
      expect(JSON.stringify(payload)).not.toContain("pendingSubmission");
      expect(JSON.stringify(payload)).not.toContain("hello world");
    }

    gate.release();
    await pending;
    expect(session(store).pendingSubmission).toBeUndefined();
  });

  it("clears the draft when preparation fails, and reports the failure", async () => {
    const store = makeStore({
      history: [item("u1", "user", "first"), item("a1", "assistant", "answer")],
    });
    const gate = holdContextRequest(store);

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: { useCodebase: false, noContext: false },
        targetMessageId: "u1",
      }),
    );
    await gate.contextRequested();
    // A replace draft renders at its target.
    expect(pendingTargetIndexFor(store)).toBe(0);

    // The target disappears while the content is resolving.
    store.dispatch({
      type: "sessions/setSessionHistory",
      payload: {
        sessionId: "s1",
        history: [item("a1", "assistant", "answer")],
      },
    });
    gate.release();
    const outcome = await pending;

    expect(outcome).toBe(false);
    // A draft that will never be sent must not stay on screen.
    expect(session(store).pendingSubmission).toBeUndefined();
    expect((store.getState() as any).ui.showDialog).toBe(true);
  });

  it("refuses a second send while one is being prepared", async () => {
    const store = makeStore();
    const gate = holdContextRequest(store);

    const first = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: { useCodebase: false, noContext: false },
      }),
    );
    await gate.contextRequested();
    const draftId = session(store).pendingSubmission.submissionId;

    const second = await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );
    expect(second).toBe(false);
    // The refused send did not replace the draft it found.
    expect(session(store).pendingSubmission.submissionId).toBe(draftId);
    expect(session(store).history).toHaveLength(2);

    gate.release();
    await first;
    expect(session(store).history).toHaveLength(4);
  });

  it("does not show a draft for a target that is not in the window", async () => {
    const store = makeStore({
      history: [item("u1", "user", "first"), item("a1", "assistant", "answer")],
    });
    const gate = holdContextRequest(store);

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
        // A window index past the end: the send is refused, so no draft is shown.
        index: 5,
      }),
    );
    await vi.waitFor(() => {
      expect(session(store).history).toHaveLength(2);
    });

    const outcome = await pending.catch(() => false);
    expect(outcome).toBe(false);
    expect(session(store).pendingSubmission).toBeUndefined();
    gate.release();
  });
});

describe("pending submission draft — reducer contract", () => {
  it("clears by id only, so a stale failure cannot remove a newer draft", () => {
    const store = makeStore();
    store.dispatch(
      setPendingSubmission({
        sessionId: "s1",
        submission: {
          submissionId: "newer",
          insertion: { kind: "append" },
          displayContent: "typed",
          startedAt: Date.now(),
        },
      }),
    );

    store.dispatch(
      clearPendingSubmission({ sessionId: "s1", submissionId: "older" }),
    );
    expect(session(store).pendingSubmission?.submissionId).toBe("newer");

    store.dispatch(
      clearPendingSubmission({ sessionId: "s1", submissionId: "newer" }),
    );
    expect(session(store).pendingSubmission).toBeUndefined();
  });

  it("is a pure runtime write: no dirty, no revision, no history", () => {
    const store = makeStore();
    const before = session(store);

    store.dispatch(
      setPendingSubmission({
        sessionId: "s1",
        submission: {
          submissionId: "s",
          insertion: { kind: "append" },
          displayContent: "typed",
          startedAt: Date.now(),
        },
      }),
    );

    const after = session(store);
    expect(after.dirty).toBe(before.dirty);
    expect(after.conversationRevision).toBe(before.conversationRevision);
    expect(after.persistence?.revision).toBe(before.persistence?.revision);
    expect(after.history).toBe(before.history);
  });
});

describe("pending submission draft — placement", () => {
  it("points a replace draft at the item that contains the target message", () => {
    const merged = {
      message: { id: "a1", role: "assistant", content: "answer" } as any,
      contextItems: [],
      mergedReplyProvenance: {
        sourceMessageIds: ["a1", "a2", "a3"],
        firstSourceMessageId: "a1",
        lastSourceMessageId: "a3",
      },
    } as ChatHistoryItemWithMessageId;
    const history = [item("u1", "user", "first"), merged];

    expect(
      pendingSubmissionTargetIndex(history, {
        submissionId: "s",
        insertion: { kind: "replace", targetMessageId: "a3" },
        displayContent: "x",
        startedAt: 0,
      }),
    ).toBe(1);
    expect(
      pendingSubmissionTargetIndex(history, {
        submissionId: "s",
        insertion: { kind: "append" },
        displayContent: "x",
        startedAt: 0,
      }),
    ).toBe(-1);
    expect(
      pendingSubmissionTargetIndex(history, {
        submissionId: "s",
        insertion: { kind: "replace", targetMessageId: "gone" },
        displayContent: "x",
        startedAt: 0,
      }),
    ).toBe(-1);
  });

  it("renders only text parts, never attachment payloads", () => {
    expect(
      pendingSubmissionText({
        submissionId: "s",
        insertion: { kind: "append" },
        displayContent: [
          { type: "text", text: "typed" },
          {
            type: "image_url",
            imageUrl: { url: "data:image/png;base64,AAAA" },
          } as any,
        ],
        startedAt: 0,
      }),
    ).toBe("typed");
  });
});

function pendingTargetIndexFor(store: ReturnType<typeof makeStore>) {
  const state = store.getState() as any;
  return pendingSubmissionTargetIndex(
    state.sessions.sessionsById.s1.history,
    state.sessions.sessionsById.s1.pendingSubmission,
  );
}
