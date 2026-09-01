import { ChatMessage, ModelDescription, PromptLog } from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { abortStream, getCachedSession } from "../slices/sessionSlice";
import { saveCurrentSession } from "./session";
import { streamNormalInput } from "./streamNormalInput";

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

  // 回归：后台流被中止（如用户在其他会话点 Stop，cancelStream→abortStream
  // 会统一 abort 所有注册流）时，流所属会话的缓存副本不能残留
  // isStreaming:true——否则切回该 tab 时 restoreCachedSession 恢复出卡住的
  // streaming 状态，回复气泡下方的操作按钮会永久消失。
  it("resets cached session isStreaming when a background stream is aborted", async () => {
    const initialState = getStateWithClaude() as any;
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-b";
    const store = createMockStore(initialState);
    const messenger = store.mockIdeMessenger;

    messenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "Hello" }],
      didPrune: false,
      contextPercentage: 0.8,
    };

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

    const streamPromise = store.dispatch(streamNormalInput({}) as any);

    await waitFor(() =>
      (store.getState() as any).session.history.some(
        (h: any) => h.message.role === "assistant",
      ),
    );

    // 切到新会话：session-b 转入后台续流（缓存快照 isStreaming:true）
    store.dispatch(saveCurrentSession({ openNewSession: true }) as any);
    expect(getCachedSession("session-b")?.isStreaming).toBe(true);

    // 模拟在其他会话触发取消：abortStream 会 abort 后台流，但不复位任何
    // streaming 状态（abortStream reducer 只 abort controller）
    store.dispatch(abortStream());
    expect(oldAborter.signal.aborted).toBe(true);

    releaseSecond();
    await streamPromise;

    // 修复点：被中止的后台流必须收尾缓存副本的 streaming 标记
    expect(getCachedSession("session-b")?.isStreaming).toBe(false);
    // 新活动会话不受影响
    expect((store.getState() as any).session.isStreaming).toBe(false);
  }, 10000);

  // 回归：活动会话的流仅被 abortStream 中止（没有任何 setInactive 路径，
  // 如单独派发 abortStream 的入口）时，thunk 退出前必须复位 isStreaming——
  // 否则最后一条回复气泡下方的操作按钮（依赖 !isStreaming）永久消失。
  it("resets isStreaming when the active session stream is aborted without setInactive", async () => {
    const initialState = getStateWithClaude() as any;
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-c";
    const store = createMockStore(initialState);
    const messenger = store.mockIdeMessenger;

    messenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "Hello" }],
      didPrune: false,
      contextPercentage: 0.8,
    };

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

    const streamPromise = store.dispatch(streamNormalInput({}) as any);

    await waitFor(() =>
      (store.getState() as any).session.history.some(
        (h: any) => h.message.role === "assistant",
      ),
    );
    expect((store.getState() as any).session.isStreaming).toBe(true);

    // 仅 abort，不派发 setInactive / cancelStream
    store.dispatch(abortStream());

    releaseSecond();
    await streamPromise;

    // 修复点：流退出时收尾，isStreaming 必须复位
    expect((store.getState() as any).session.isStreaming).toBe(false);
    // 缓存副本同步复位，避免切走再切回时恢复出卡住的 streaming 状态
    expect(getCachedSession("session-c")?.isStreaming).toBe(false);
  }, 10000);

  // 回归：同会话、无工具调用、模型流式回复中途报错（网络错误/500 等）——
  // 用户一直停留在原会话等回复的最常见错误场景。thunk 上抛错误前必须先
  // 收尾 streaming 状态：isStreaming 卡 true 会让最后一条回复气泡下方的
  // 操作按钮（依赖 !isStreaming）永久消失；缓存副本残留 true 则会在之后
  // 切走再切回时经 restoreCachedSession 恢复出卡住的状态。
  it("resets isStreaming when the stream errors mid-way without tool calls", async () => {
    const initialState = getStateWithClaude() as any;
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-d";
    const store = createMockStore(initialState);
    const messenger = store.mockIdeMessenger;

    messenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "Hello" }],
      didPrune: false,
      contextPercentage: 0.8,
    };

    async function* generator(): AsyncGenerator<ChatMessage[], PromptLog> {
      yield [{ role: "assistant", content: "First" }];
      throw new Error("boom: connection reset mid-stream");
    }
    const mockStreamChat = vi.fn();
    mockStreamChat.mockReturnValue(generator());
    messenger.llmStreamChat = mockStreamChat;

    const streamPromise = store.dispatch(streamNormalInput({}) as any);

    // 错误上抛（运行时由 streamThunkWrapper 弹错误框）：createAsyncThunk
    // 的 dispatch promise 不 reject，而是 resolve 出 rejected action
    const result: any = await streamPromise;
    expect(result.error?.message).toContain("boom");

    // 修复点：thunk 退出前收尾，isStreaming 必须复位
    expect((store.getState() as any).session.isStreaming).toBe(false);
    // 缓存副本同步复位，避免之后切走再切回时恢复出卡住的 streaming 状态
    expect(getCachedSession("session-d")?.isStreaming).toBe(false);
    // 已流出的部分回复不被清掉
    const assistant = (store.getState() as any).session.history.find(
      (h: any) => h.message.role === "assistant",
    );
    expect(assistant?.message.content).toBe("First");
  }, 10000);
});
