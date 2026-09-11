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
import {
  readSubmitLatencyEvents,
  resetSubmitLatencyEvents,
} from "../../util/submitLatency";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";

/**
 * Workflow "submit latency and retry boundary", step 1: diagnostics only.
 *
 * Two things are pinned here, both of which were broken by the Stage 2F reordering and
 * are prerequisites for the pending-bubble work:
 *
 * 1. the "gathering context" state is **session**-scoped and always cleared — including
 *    when a context provider throws (it used to be written onto `history.at(-1)`, which
 *    no longer exists while the send is still resolving);
 * 2. the latency events exist for the phases the send goes through, and they carry **no**
 *    prompt text, paths or context payloads.
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

function makeStore() {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [item("u1", "user", "earlier"), item("a1", "assistant", "sure")],
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

describe("submit diagnostics — gathering flag ownership", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
    resetSubmitLatencyEvents();
  });

  it("clears the session flag when a context provider throws", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    request.mockImplementation((async (type: string) => {
      if (type === "context/getContextItems") {
        throw new Error("provider exploded");
      }
      return { status: "success", content: {}, done: true };
    }) as any);

    const outcome = await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        // Context gathering on: the flag must be set and then released.
        modifiers: { useCodebase: false, noContext: false },
      }),
    );

    expect(outcome).toBe(false);
    // The bug this pins: the old code only dispatched `gathering: false` on the happy
    // path, so a throwing provider left the session in "gathering context" forever.
    expect(session(store).isGatheringContext).toBeFalsy();
    // No submitted turn, no save, no request to the model.
    expect(session(store).history).toHaveLength(2);
  });

  it("owns the flag on the session, not on the last history item", async () => {
    const store = makeStore();
    let resolveProvider: ((value: any) => void) | undefined;
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    request.mockImplementation(((type: string) => {
      if (type === "context/getContextItems") {
        return new Promise((resolve) => {
          resolveProvider = () =>
            resolve({ status: "success", content: [], done: true });
        });
      }
      return Promise.resolve({ status: "success", content: {}, done: true });
    }) as any);

    const pending = run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: { useCodebase: false, noContext: false },
      }),
    );
    await vi.waitFor(() => expect(resolveProvider).toBeDefined());

    // While resolving, the session reports gathering and **no** submitted turn exists yet
    // — which is exactly why the flag cannot live on `history.at(-1)`.
    expect(session(store).isGatheringContext).toBe(true);
    expect(session(store).history).toHaveLength(2);
    expect(
      session(store).history.every((entry: any) => !entry.isGatheringContext),
    ).toBe(true);

    resolveProvider!(undefined);
    await pending;
    expect(session(store).isGatheringContext).toBeFalsy();
  });
});

describe("submit diagnostics — latency events", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
    resetSubmitLatencyEvents();
  });

  it("records every phase of a send, without leaking any content", async () => {
    const store = makeStore();
    const SECRET = "unique-marker-7f3a9c-do-not-log";
    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: SECRET }] },
          ],
        },
        modifiers: MODIFIERS,
      }),
    );

    const events = readSubmitLatencyEvents();
    const phases = new Set<string>(events.map((event) => event.phase));
    // The spans that bracket the user-visible wait…
    expect(phases.has("editor-processing")).toBe(true);
    expect(phases.has("slash-rendering")).toBe(true);
    expect(phases.has("context-resolution")).toBe(true);
    expect(phases.has("submit-to-commit")).toBe(true);
    expect(phases.has("commit-turn")).toBe(true);
    expect(phases.has("save-enqueue")).toBe(true);
    expect(phases.has("stream-start")).toBe(true);
    // …and the terminal side, which runs in the terminal commit's own task.
    expect(phases.has("terminal-commit")).toBe(true);
    expect(phases.has("terminal-save-enqueue")).toBe(true);

    // Durations are numbers, insertion shape is a closed enum.
    const commit = events.find((event) => event.phase === "commit-turn")!;
    expect(typeof commit.durationMs).toBe("number");
    expect(commit.insertion).toBe("append");
    expect(commit.hadContext).toBe(false);

    // Privacy: no prompt text, no paths, no context payloads anywhere in the events.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("/Users/");
    for (const event of events) {
      for (const key of Object.keys(event)) {
        expect([
          "phase",
          "sessionId",
          "durationMs",
          "provider",
          "requests",
          "hadContext",
          "insertion",
          "ok",
        ]).toContain(key);
      }
    }
  });

  it("records the provider name without its query", async () => {
    const store = makeStore();
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const seen: any[] = [];
    request.mockImplementation((async (type: string, data: any) => {
      if (type === "context/getContextItems") {
        seen.push(data);
        return { status: "success", content: [], done: true };
      }
      return { status: "success", content: {}, done: true };
    }) as any);

    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: { useCodebase: false, noContext: false },
      }),
    );

    // The provider was really asked (that is the latency source) and the event names it.
    expect(seen.some((entry) => entry.name === "currentFile")).toBe(true);
    const providerEvents = readSubmitLatencyEvents().filter(
      (event) => event.provider !== undefined,
    );
    expect(providerEvents.map((event) => event.provider)).toContain(
      "currentFile",
    );
    const serialized = JSON.stringify(providerEvents);
    // The query the app sends is not part of the log; only the provider name is.
    expect(serialized).not.toContain("non-mention-usage");
  });

  it("exposes the buffer for a support session without enabling anything", async () => {
    const store = makeStore();
    await run(
      store,
      submitSessionInput({
        sessionId: "s1",
        editorState: EDITOR_STATE,
        modifiers: MODIFIERS,
      }),
    );

    // The console helper is installed lazily on the first event.
    const helper = (globalThis as any).window?.__continueSubmitLatencyEvents;
    expect(typeof helper).toBe("function");
    expect(helper().length).toBeGreaterThan(0);
  });
});

describe("submit diagnostics — resolveEditorContent contract unchanged", () => {
  it("returns the same shape it did before instrumentation", async () => {
    const store = makeStore();
    const result = await resolveEditorContent({
      sessionId: "s1",
      editorState: EDITOR_STATE,
      modifiers: MODIFIERS,
      ideMessenger: store.mockIdeMessenger,
      defaultContextProviders: [],
      availableSlashCommands: [],
      dispatch: store.dispatch,
      getState: () => store.getState() as any,
    });

    expect(Object.keys(result).sort()).toEqual([
      "content",
      "legacyCommandWithInput",
      "selectedCode",
      "selectedContextItems",
    ]);
    expect(result.legacyCommandWithInput).toBeUndefined();
    expect(result.selectedContextItems).toEqual([]);
    expect(JSON.stringify(result.content)).toContain("hello world");
  });
});
