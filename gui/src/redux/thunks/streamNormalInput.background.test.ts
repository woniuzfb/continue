import { ChatMessage, ModelDescription, PromptLog } from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { getCachedSession } from "../slices/sessionSlice";
import { streamNormalInput } from "./streamNormalInput";
import { saveCurrentSession } from "./session";

// Mock system message construction to keep the test readable
vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-123"),
}));

const mockClaudeModel: ModelDescription = {
  title: "Claude 3.5 Sonnet",
  model: "claude-3-5-sonnet-20241022",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  completionOptions: { reasoningBudgetTokens: 2048 },
};

function getStateWithClaude() {
  const state = getEmptyRootState();
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: mockClaudeModel,
        },
      },
    },
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("streamNormalInput background streaming", () => {
  it("keeps streaming into the cached session after switching away, without aborting", async () => {
    const initialState = getStateWithClaude() as any;
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-a";
    const store = createMockStore(initialState);
    const messenger = store.mockIdeMessenger;

    messenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "Hello" }],
      didPrune: false,
      contextPercentage: 0.8,
    };

    // Controllable generator: first chunk immediately, second chunk gated
    let releaseSecond: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    async function* generator(): AsyncGenerator<ChatMessage[], PromptLog> {
      yield [{ role: "assistant", content: "First" }];
      await gate;
      yield [{ role: "assistant", content: "Second" }];
      return {
        prompt: "Hello",
        completion: "FirstSecond",
        modelProvider: "anthropic",
        modelTitle: "Claude 3.5 Sonnet",
      };
    }
    const mockStreamChat = vi.fn();
    mockStreamChat.mockReturnValue(generator());
    messenger.llmStreamChat = mockStreamChat;

    const oldAborter = (store.getState() as any).session.streamAborter;

    // Start streaming (don't await yet)
    const streamPromise = store.dispatch(streamNormalInput({}) as any);

    // Wait until the first chunk has been pumped into state (stream parked on gate)
    await waitFor(() =>
      (store.getState() as any).session.history.some(
        (h: any) => h.message.role === "assistant",
      ),
    );

    // Switch to a brand-new session, exactly like clicking "+" does:
    // saveCurrentSession({openNewSession:true}) caches the current session
    // (with chunks pumped so far) and dispatches newSession synchronously.
    store.dispatch(saveCurrentSession({ openNewSession: true }) as any);

    // Release the remaining chunks
    releaseSecond();

    await streamPromise;

    // The old session's AbortController must NOT have been aborted
    expect(oldAborter.signal.aborted).toBe(false);

    // The active (new) session must not be polluted with the old stream
    expect((store.getState() as any).session.id).not.toBe("session-a");
    expect(
      (store.getState() as any).session.history.some(
        (h: any) => h.message.role === "assistant",
      ),
    ).toBe(false);

    // The background stream wrote the full content (pre-switch "First" from
    // the cache snapshot + post-switch "Second") into session-a's cache
    const cached = getCachedSession("session-a");
    expect(cached).toBeDefined();
    const assistant = cached!.history.find(
      (h) => h.message.role === "assistant",
    );
    expect(assistant?.message.content).toBe("FirstSecond");
    // Session marked as no longer streaming
    expect(cached!.isStreaming).toBe(false);
  }, 10000);
});
