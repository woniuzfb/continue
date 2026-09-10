import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { createMockStore } from "../../util/test/mockStore";
import { INITIAL_CONFIG_SLICE } from "../../redux/slices/configSlice";
import type { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
import { resetSessionSaveQueues } from "../../redux/thunks/sessionPersistence";
import { resetSessionStreamCheckpoints } from "../../redux/thunks/sessionStreams";
import { resetSessionStreamRunner } from "../../redux/thunks/sessionTools";
import StreamErrorDialog from "./StreamError";

/**
 * The dialog only needs *an* editor; what this file asserts is the resend-target
 * decision, so the editor wiring is stubbed instead of rendered.
 *
 * Mock the **source** module, not the `TipTapEditor` barrel: mocking the barrel
 * resolves for this file's own imports but not for `StreamError`'s, which keeps a
 * real binding, reports "Main editor not found" and returns early — a silent
 * false pass for the assertions below.
 */
vi.mock(
  "../../components/mainInput/TipTapEditor/MainEditorProvider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../components/mainInput/TipTapEditor/MainEditorProvider")
      >();
    return {
      ...actual,
      useMainEditorForSession: () => ({
        mainEditor: { getJSON: () => ({ type: "doc", content: [] }) },
      }),
    } as unknown as typeof actual;
  },
);

const CHAT_MODEL = { title: "gpt-4o", provider: "openai", model: "gpt-4o" };

function item(
  id: string,
  role: "user" | "assistant" | "tool",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function makeStore(history: ChatHistoryItemWithMessageId[]) {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history,
    mode: "agent",
    chatModelTitle: CHAT_MODEL.title,
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
    // A configured chat model on purpose: without one the send would fail before
    // writing anything, and this file could not tell "aborted" from "failed".
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat: [CHAT_MODEL as any],
        },
        selectedModelByRole: {
          ...INITIAL_CONFIG_SLICE.config.selectedModelByRole,
          chat: CHAT_MODEL as any,
        },
      },
    },
  });
}

function historyOf(store: ReturnType<typeof makeStore>) {
  return (store.getState() as any).sessions.sessionsById.s1
    .history as ChatHistoryItemWithMessageId[];
}

async function renderDialog(store: ReturnType<typeof makeStore>) {
  const rendered = await renderWithProviders(
    <StreamErrorDialog
      error={new Error("Something went wrong")}
      sessionId="s1"
    />,
    { store: store as any },
  );
  // The shell's bootstrapping dispatches its own actions before the click; the
  // assertions below read `sessions/submitInput/pending` from this point on.
  store.clearActions();
  return rendered;
}

function submitActions(store: ReturnType<typeof makeStore>) {
  return store
    .getActions()
    .filter((a: any) => a.type === "sessions/submitInput/pending");
}

describe("StreamErrorDialog resubmit", () => {
  beforeEach(() => {
    resetSessionSaveQueues();
    resetSessionStreamCheckpoints();
    resetSessionStreamRunner();
  });

  it("aborts instead of appending when no user/tool target is loaded", async () => {
    // 方案.md §十二 / audit §5: a miss aborts explicitly. Resending a previous
    // turn is not the same as sending a new one, so neither of the two old
    // stand-ins for a missing target is allowed — `index: 0` (the window's first
    // item once the window is lazy) and `undefined` (append).
    const store = makeStore([item("a1", "assistant", "reply")]);
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { user } = await renderDialog(store);
    await user.click(screen.getByText("Resubmit last message"));

    // The send was never dispatched — no new turn, no save, no model call …
    expect(submitActions(store)).toHaveLength(0);
    expect(historyOf(store)).toHaveLength(1);
    expect(historyOf(store)[0].message.role).toBe("assistant");
    expect(historyOf(store).some((h) => h.message.role === "user")).toBe(false);
    expect(request).not.toHaveBeenCalledWith("history/save", expect.anything());
    expect(request).not.toHaveBeenCalledWith(
      "llm/streamChat",
      expect.anything(),
    );
    // … and the abort branch is what ran.
    expect(warn).toHaveBeenCalledWith(
      "Cannot resend: the target message is no longer in the loaded history",
    );

    warn.mockRestore();
  });

  it("resubmits the last user turn by its window index when it is loaded", async () => {
    // Control for the test above: the button does send when the target *is* in
    // the window, and it addresses that turn (index 0 here) rather than
    // appending — `undefined` would mean "a new message".
    const store = makeStore([
      item("u1", "user", "first"),
      item("a1", "assistant", "reply"),
    ]);

    const { user } = await renderDialog(store);
    await user.click(screen.getByText("Resubmit last message"));

    const submit = submitActions(store);
    expect(submit).toHaveLength(1);
    expect((submit[0] as any).meta.arg).toMatchObject({
      sessionId: "s1",
      index: 0,
    });
  });
});
