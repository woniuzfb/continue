import { render, screen } from "@testing-library/react";
import { JSONContent } from "@tiptap/core";
import { InputModifiers, PromptLog } from "core";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import StepContainer from "../../components/StepContainer/StepContainer";
import { IdeMessengerProvider } from "../../context/IdeMessenger";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore } from "../../util/test/mockStore";
import { streamResponseThunk } from "./streamResponse";

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(),
}));

import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-123"),
}));

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(),
  }),
);

import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { getRootStateWithClaude } from "./streamResponse.test";

const mockGetBaseSystemMessage = vi.mocked(getBaseSystemMessage);
const mockResolveEditorContent = vi.mocked(resolveEditorContent);

const mockEditorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello, please help me with this code" }],
    },
  ],
};

const mockModifiers: InputModifiers = {
  useCodebase: true,
  noContext: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEditorContent.mockResolvedValue({
    selectedContextItems: [],
    selectedCode: [],
    content: "Hello, please help me with this code",
    legacyCommandWithInput: undefined,
  });
  mockGetBaseSystemMessage.mockReturnValue("You are a helpful assistant.");
});

describe("streamNormalInput - mid-stream error in active session, pure text", () => {
  it("resets isStreaming and keeps the partial reply bubble when the stream throws mid-flight", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-err";
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;

    mockIdeMessenger.request = vi.fn(async (message: any) => {
      if (message === "llm/compileChat") {
        return {
          done: true,
          status: "success",
          content: {
            compiledChatMessages: [{ role: "user", content: "Hello" }],
            didPrune: false,
            contextPercentage: 0.5,
          },
        } as any;
      }
      return { done: true, status: "success", content: undefined } as any;
    });

    // 流式到一半抛错：先出一个 chunk，再失败
    async function* generator(): AsyncGenerator<
      { role: string; content: string }[],
      PromptLog | undefined
    > {
      yield [{ role: "assistant", content: "Partial reply" }];
      throw new Error("Provider exploded mid-stream");
    }
    mockIdeMessenger.llmStreamChat = vi.fn().mockReturnValue(generator());

    await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    const state = (mockStore.getState() as any).session;

    // 核心断言：错误中断后 isStreaming 必须复位（按钮恢复显示的前提）
    expect(state.isStreaming).toBe(false);

    // 有部分内容的 assistant 气泡必须保留（clearDanglingMessages 不回滚它）
    const assistant = state.history.find(
      (h: any) => h.message.role === "assistant",
    );
    expect(assistant).toBeDefined();
    expect(assistant.message.content).toBe("Partial reply");

    // 永久错误应弹出错误对话框
    expect((mockStore.getState() as any).ui.showDialog).toBe(true);
  }, 15000);

  it("rolls the exchange back when the stream errors before any content arrives", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-err2";
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;

    mockIdeMessenger.request = vi.fn(async (message: any) => {
      if (message === "llm/compileChat") {
        return {
          done: true,
          status: "success",
          content: {
            compiledChatMessages: [{ role: "user", content: "Hello" }],
            didPrune: false,
            contextPercentage: 0.5,
          },
        } as any;
      }
      return { done: true, status: "success", content: undefined } as any;
    });

    // 第一个 chunk 就失败，没有任何内容落盘
    async function* generator(): AsyncGenerator<
      { role: string; content: string }[],
      PromptLog | undefined
    > {
      throw new Error("Immediate failure");
      yield []; // unreachable, keeps TS happy about generator typing
    }
    mockIdeMessenger.llmStreamChat = vi.fn().mockReturnValue(generator());

    await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    const state = (mockStore.getState() as any).session;
    expect(state.isStreaming).toBe(false);
    // 没有任何 assistant 内容：整轮对话回滚进输入框（既有设计行为）
    expect(state.history.some((h: any) => h.message.role === "assistant")).toBe(
      false,
    );
  }, 15000);

  // 端到端验证：报错中断后，最后一条回复气泡下方的操作按钮排
  // （compact/delete/copy，即 StepContainer 的 ResponseActions）必须真实
  // 渲染出来——而不只是 isStreaming 复位了。用真实 store 渲染组件断言。
  it("renders the response action row after a mid-stream error", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-err3";
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;

    mockIdeMessenger.request = vi.fn(async (message: any) => {
      if (message === "llm/compileChat") {
        return {
          done: true,
          status: "success",
          content: {
            compiledChatMessages: [{ role: "user", content: "Hello" }],
            didPrune: false,
            contextPercentage: 0.5,
          },
        } as any;
      }
      return { done: true, status: "success", content: undefined } as any;
    });

    async function* generator(): AsyncGenerator<
      { role: string; content: string }[],
      PromptLog | undefined
    > {
      yield [{ role: "assistant", content: "Partial reply" }];
      throw new Error("Provider exploded mid-stream");
    }
    mockIdeMessenger.llmStreamChat = vi.fn().mockReturnValue(generator());

    await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    const sessionState = (mockStore.getState() as any).session;
    expect(sessionState.isStreaming).toBe(false);

    // 用报错后的真实 state 渲染最后一条 assistant 气泡
    const lastIdx = sessionState.history.length - 1;
    const lastItem = sessionState.history[lastIdx];
    expect(lastItem.message.role).toBe("assistant");

    render(
      <Provider store={mockStore as any}>
        <IdeMessengerProvider messenger={new MockIdeMessenger()}>
          <StepContainer item={lastItem} index={lastIdx} isLast={true} />
        </IdeMessengerProvider>
      </Provider>,
    );

    // 那一排按钮必须生成：compact + delete（ResponseActions 内的按钮排）
    expect(screen.getByTestId(`compact-button-${lastIdx}`)).toBeTruthy();
    expect(screen.getByTestId(`delete-button-${lastIdx}`)).toBeTruthy();
  }, 15000);
});
