import { ChatMessage } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToolCallDeltaToState } from "../../util/toolCallState";
import {
  abortStream,
  applyStreamUpdatesToHistory,
  ChatHistoryItemWithMessageId,
  mergeSplitReplies,
  newSession,
  registerStreamAborter,
  restoreCachedSession,
  sessionSlice,
  unregisterStreamAborter,
} from "./sessionSlice";

// Mock dependencies
vi.mock("uuid");
vi.mock("core/util/messageContent");
vi.mock("../../util/toolCallState");

const mockUuidv4 = vi.mocked(uuidv4);
const mockRenderChatMessage = vi.mocked(renderChatMessage);
const mockAddToolCallDeltaToState = vi.mocked(addToolCallDeltaToState);

describe("sessionSlice streamUpdate", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Mock uuidv4 to return predictable values
    let callCount = 0;
    mockUuidv4.mockImplementation(() => `mock-uuid-${++callCount}`);

    // Mock renderChatMessage to return content as is
    mockRenderChatMessage.mockImplementation((message: ChatMessage) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return "";
    });

    // Mock addToolCallDeltaToState
    mockAddToolCallDeltaToState.mockImplementation((delta, state) => {
      return {
        status: "generating" as const,
        toolCall: {
          id: delta.id || "mock-tool-id",
          type: "function" as const,
          function: {
            name: delta.function?.name || "mock-function",
            arguments: delta.function?.arguments || "{}",
          },
        },
        toolCallId: delta.id || "mock-tool-id",
        parsedArgs: {},
      };
    });
  });

  const createInitialState = () => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history: [
      {
        message: {
          role: "user" as const,
          content: "This is a test.",
          id: "initial-user-message",
        },
        contextItems: [],
      },
    ] as ChatHistoryItemWithMessageId[],
    isStreaming: false,
    title: "Test Session",
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    isInEdit: false,
    codeBlockApplyStates: {
      states: [],
      curIndex: 0,
    },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    dontMergeReplyBubbles: false, // 测试合并行为时默认开启合并
    dontMergeHistoricalReplyBubbles: false,
  });

  describe("Basic Chat Message", () => {
    it("should append assistant message to history", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "Here is a response to your message without thinking.",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe(
        "Here is a response to your message without thinking.",
      );
      expect(newState.history[1].message.id).toBe("mock-uuid-1");
      expect(newState.history[1].contextItems).toEqual([]);
    });
  });

  describe("Chat Message With Thinking", () => {
    it("should split thinking and assistant content correctly", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content:
              "<think>I should send the user a response.</think> Here is a response to your message with thinking.",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should send the user a response.",
      );

      // Check assistant message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe(
        "Here is a response to your message with thinking.",
      );
      expect(newState.history[1].message.id).toBe("mock-uuid-1");
    });

    it("should create separate thinking item when reasoning_content arrives", () => {
      // Simulates the user's scenario: server sends
      //   {"delta": {"role": "assistant", "reasoning_content": "..."}}
      // which fromChatCompletionChunk converts to {role:"thinking", content:"..."}.
      // Initial state mirrors what submitEditorAndInitAtIndex creates:
      //   [user_msg, empty assistant placeholder]
      const initialState = createInitialState();
      initialState.history.push({
        message: {
          role: "assistant" as const,
          content: "",
          id: "assistant-placeholder",
        },
        contextItems: [],
      });

      const thinkingAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            content: "思考中…",
          },
        ],
      };
      let newState = sessionSlice.reducer(initialState, thinkingAction);

      // History should now be: [user, assistant_placeholder, thinking]
      expect(newState.history).toHaveLength(3);
      const thinkingItem = newState.history[2];
      expect(thinkingItem.message.role).toBe("thinking");
      // Thinking content should be stored on message.content (read by Chat.tsx
      // via renderChatMessage when rendering the ThinkingBlockPeek).
      expect(thinkingItem.message.content).toBe("思考中…");

      // Now stream an assistant content chunk - should create a 4th item
      const answerAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "你",
          },
        ],
      };
      newState = sessionSlice.reducer(newState, answerAction);
      expect(newState.history).toHaveLength(4);
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe("你");
      // Thinking item content should be preserved
      expect(newState.history[2].message.content).toBe("思考中…");
    });
  });

  describe("Tool Call With Response", () => {
    it("should handle tool call followed by tool response and assistant message", () => {
      const initialState = createInitialState();
      const toolCallAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "<think>I should use a tool call.</think>",
            toolCalls: [
              {
                id: "1234",
                type: "function" as const,
                function: {
                  name: "builtin_ls",
                  arguments: '{"dirPath":".","recursive":false}',
                },
              },
            ],
          },
        ],
      };

      let newState = sessionSlice.reducer(initialState, toolCallAction);
      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should use a tool call.",
      );

      // Check generating message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[1].toolCallStates?.[0]?.status).toBe(
        "generating",
      );
      expect(newState.history[1].toolCallStates?.[0]?.toolCallId).toBe("1234");

      const toolResponseAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "tool" as const,
            toolCallId: "1234",
            content: "foo.txt\nbar.txt\nexample.php",
          },
          {
            role: "assistant" as const,
            content: "I see, the tool found 3 files.",
          },
        ],
      };
      newState = sessionSlice.reducer(newState, toolResponseAction);
      expect(newState.history).toHaveLength(4);

      // Check tool message
      expect(newState.history[2].message.role).toBe("tool");
      expect(newState.history[2].message.content).toBe(
        "foo.txt\nbar.txt\nexample.php",
      );
      expect((newState.history[2].message as any).toolCallId).toBe("1234");

      // Check final assistant message
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe(
        "I see, the tool found 3 files.",
      );
    });
  });

  describe("Tool Call With Streaming Response", () => {
    it("should handle streaming assistant response after tool call", () => {
      const initialState = createInitialState();
      const toolCallAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "<think>I should use a tool call.</think>",
            toolCalls: [
              {
                id: "1234",
                type: "function" as const,
                function: {
                  name: "builtin_ls",
                  arguments: '{"dirPath":".","recursive":false}',
                },
              },
            ],
          },
        ],
      };

      let newState = sessionSlice.reducer(initialState, toolCallAction);
      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should use a tool call.",
      );

      // Check generating message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[1].toolCallStates?.[0]?.status).toBe(
        "generating",
      );
      expect(newState.history[1].toolCallStates?.[0]?.toolCallId).toBe("1234");

      const toolResponseAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "tool" as const,
            toolCallId: "1234",
            content: "foo.txt\nbar.txt\nexample.php",
          },
          {
            role: "assistant" as const,
            content: "<think>",
          },
          {
            role: "assistant" as const,
            content: "Good, ",
          },
          {
            role: "assistant" as const,
            content: "I received a list",
          },
          {
            role: "assistant" as const,
            content: " of files.",
          },
          {
            role: "assistant" as const,
            content: "</think>",
          },
          {
            role: "assistant" as const,
            content: "\n",
          },
          {
            role: "assistant" as const,
            content: "I see, ",
          },
          {
            role: "assistant" as const,
            content: "the tool ",
          },
          {
            role: "assistant" as const,
            content: "found 3 ",
          },
          {
            role: "assistant" as const,
            content: "files.",
          },
        ],
      };

      newState = sessionSlice.reducer(newState, toolResponseAction);

      expect(newState.history).toHaveLength(4);

      // Check tool message
      expect(newState.history[2].message.role).toBe("tool");
      expect(newState.history[2].message.content).toBe(
        "foo.txt\nbar.txt\nexample.php",
      );

      // Check response message
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe(
        "I see, the tool found 3 files.",
      );
      expect(newState.history[3].reasoning?.text).toBe(
        "Good, I received a list of files.",
      );
      expect(newState.history[3].reasoning?.active).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty history gracefully", () => {
      const initialState = createInitialState();
      initialState.history = [];

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "Hello",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      // Should not crash and history should remain empty
      expect(newState.history).toHaveLength(0);
    });

    it("should handle redacted thinking messages", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            content: "This should be hidden",
            redactedThinking: true,
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("thinking");
      expect(newState.history[1].message.content).toBe(
        "internal reasoning is hidden due to safety reasons",
      );
      expect((newState.history[1].message as any).redactedThinking).toBe(true);
    });

    it("should handle signature updates for thinking messages", () => {
      const initialState = createInitialState();
      // First add a thinking message
      initialState.history.push({
        message: {
          role: "thinking",
          content: "Some thinking",
          id: "thinking-message",
        },
        contextItems: [],
      });

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            signature: "test-signature",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect((newState.history[1].message as any).signature).toBe(
        "test-signature",
      );
    });

    it("should accumulate content for same role messages", () => {
      const initialState = createInitialState();
      // Add an assistant message first
      initialState.history.push({
        message: {
          role: "assistant",
          content: "Hello ",
          id: "assistant-message",
        },
        contextItems: [],
      });

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "world!",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.content).toBe("Hello world!");
    });

    it("should handle basic tool call streaming", () => {
      const initialState = createInitialState();
      const toolCallId = "call_123";

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "",
            toolCalls: [
              {
                id: toolCallId,
                type: "function" as const,
                function: {
                  name: "test_tool",
                  arguments: '{"arg":"value"}',
                },
              },
            ],
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].toolCallStates).toHaveLength(1);
    });
  });

  describe("mid-response thinking (no reply split)", () => {
    /** Real flow shape: submitEditorAndInitAtIndex creates an empty assistant placeholder. */
    const realFlowState = () => ({
      ...createInitialState(),
      history: [
        ...createInitialState().history,
        {
          message: {
            role: "assistant" as const,
            content: "",
            id: "placeholder",
          },
          contextItems: [],
        },
      ],
    });

    const stream = (state: any, chunks: any[]) => {
      let s = state;
      for (const c of chunks) {
        s = sessionSlice.reducer(s, {
          type: "session/streamUpdate",
          payload: [c],
        } as any);
      }
      return s;
    };

    it("keeps the reply in ONE assistant item when thinking arrives mid-response", () => {
      // The user's real shape: assistant(5368) → thinking(348) → assistant(40).
      const newState = stream(realFlowState() as any, [
        {
          role: "assistant" as const,
          content: "你这批帧其实已经能稳定解开…`TOKEN",
        },
        {
          role: "thinking" as const,
          content: "Interpreting object IDs and commands…",
        },
        { role: "assistant" as const, content: "` 不参与这次广播解密；…" },
      ]);

      const assistantItems = newState.history.filter(
        (i: any) => i.message.role === "assistant",
      );
      expect(assistantItems).toHaveLength(1);
      expect(assistantItems[0].message.content).toBe(
        "你这批帧其实已经能稳定解开…`TOKEN` 不参与这次广播解密；…",
      );
      // The thinking item is preserved as its own history item.
      const thinkingItems = newState.history.filter(
        (i: any) => i.message.role === "thinking",
      );
      expect(thinkingItems).toHaveLength(1);
    });

    it("normal reasoning_content flow (thinking before answer) is unchanged", () => {
      const newState = stream(realFlowState() as any, [
        { role: "thinking" as const, content: "思考中…" },
        { role: "assistant" as const, content: "你" },
        { role: "assistant" as const, content: "好" },
      ]);

      // Same shape as before the fix: placeholder stays empty, thinking item,
      // then a separate assistant item with the answer.
      expect(newState.history).toHaveLength(4);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[2].message.role).toBe("thinking");
      expect(newState.history[2].message.content).toBe("思考中…");
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe("你好");
    });
  });

  describe("mergeSplitReplies (old-session repair on load)", () => {
    const item = (role: any, content: string, extra?: any) => ({
      message: { role, content, id: `id-${role}-${content.slice(0, 8)}` },
      contextItems: [],
      ...extra,
    });

    it("merges the real split shape: assistant→thinking→assistant→thinking→assistant", () => {
      // Mirrors the session file on disk: empty placeholder, thinking, main
      // answer (ends mid-sentence at `TOKEN), thinking, 40-char tail.
      // The split sits in the SECOND turn: the first turn is exempt from
      // merging (session-ID anchor) and must stay untouched.
      const history = [
        item("user", "hello"),
        item("assistant", "首轮正常回复"),
        item("user", "next question"),
        item("assistant", ""),
        item("thinking", "Interpreting object IDs…"),
        item("assistant", "你这批帧其实已经能稳定解开…`TOKEN"),
        item("thinking", "second reasoning block"),
        item("assistant", "` 不参与这次广播解密；…"),
        item("user", "last"),
      ] as any;

      const repaired = mergeSplitReplies(history);

      // First turn untouched; second turn merged into one assistant item with
      // the exact concatenated reply (mid-sentence cut restored), thinking
      // moved to reasoning.
      const assistants = repaired.filter(
        (i: any) => i.message.role === "assistant",
      );
      expect(assistants).toHaveLength(2);
      expect(assistants[0].message.content).toBe("首轮正常回复");
      expect(assistants[1].message.content).toBe(
        "你这批帧其实已经能稳定解开…`TOKEN` 不参与这次广播解密；…",
      );
      expect(assistants[1].reasoning?.text).toBe(
        "Interpreting object IDs…\n\nsecond reasoning block",
      );
      // The trailing user message is untouched.
      expect(repaired[repaired.length - 1].message.role).toBe("user");
    });

    it("leaves the normal reasoning_content flow untouched", () => {
      const history = [
        item("user", "hello"),
        item("assistant", ""),
        item("thinking", "思考中…"),
        item("assistant", "这是回答"),
      ] as any;

      const repaired = mergeSplitReplies(history);
      expect(repaired).toHaveLength(4);
      expect(repaired[3].message.content).toBe("这是回答");
    });

    it("does NOT merge the first turn (session-ID anchor)", () => {
      // 服务端可能依据首轮内容确定会话 ID：首轮的拆分必须保持原样。
      const history = [
        item("user", "hello"),
        item("assistant", "head "),
        item("thinking", "t"),
        item("assistant", "tail"),
        item("user", "q2"),
        item("assistant", "x"),
      ] as any;

      const repaired = mergeSplitReplies(history);
      expect(repaired).toHaveLength(6); // 第一轮不合并，原样保留
      expect(repaired[1].message.content).toBe("head ");
      expect(repaired[2].message.role).toBe("thinking");
      expect(repaired[3].message.content).toBe("tail");
    });

    it("is idempotent", () => {
      const history = [
        item("user", "hello"),
        item("assistant", "first reply"),
        item("user", "q2"),
        item("assistant", "a"),
        item("thinking", "t"),
        item("assistant", "b"),
      ] as any;

      const once = mergeSplitReplies(history);
      const twice = mergeSplitReplies(once);
      expect(twice).toEqual(once);
      expect(
        twice.filter((i: any) => i.message.role === "assistant"),
      ).toHaveLength(2);
    });

    it("is applied when a session is loaded via newSession", () => {
      const initialState = createInitialState();
      const splitHistory = [
        item("user", "hello"),
        item("assistant", "first reply"),
        item("user", "q2"),
        item("assistant", "head "),
        item("thinking", "t"),
        item("assistant", "tail"),
      ];

      const newState = sessionSlice.reducer(
        initialState as any,
        {
          type: "session/newSession",
          payload: { history: splitHistory },
        } as any,
      );

      const assistants = newState.history.filter(
        (i: any) => i.message.role === "assistant",
      );
      expect(assistants).toHaveLength(2);
      expect(assistants[1].message.content).toBe("head tail");
    });

    it("merges turn-internal bubbles even on a lazily paginated tail page", () => {
      // 合并的是“轮次内”的气泡块，与分页正交。懒加载的尾部页同样要合并；
      // 分页偏移由 loadedDiskCount（已加载磁盘条目数）记账，不受合并影响。
      const initialState = createInitialState();
      const tailPage = [
        item("user", "hello"),
        item("assistant", "first reply"),
        item("user", "q2"),
        item("assistant", "head "),
        item("thinking", "t"),
        item("assistant", "tail"),
      ];

      const newState = sessionSlice.reducer(
        initialState as any,
        {
          type: "session/newSession",
          payload: {
            history: tailPage,
            historyTruncated: true,
            historyLoadedOffset: 10,
            historyTotalCount: 16,
          },
        } as any,
      );

      // 首轮不合并；第二轮 4 条 → 2 条（assistant+thinking+assistant 并为一条）
      expect(newState.history).toHaveLength(4);
      expect(newState.history[1].message.content).toBe("first reply");
      expect(newState.history[3].message.content).toBe("head tail");
      // 但磁盘记账保持原始页条数，翻页 offset 不会错位
      expect(newState.loadedDiskCount).toBe(6);
    });

    it("keeps toolCalls/toolCallStates from ANY assistant item in the group", () => {
      // 拆分场景：text → thinking → text + toolCall。tool call 落在后面的
      // assistant 条目上，合并后必须保留，否则工具调用链断裂。
      const history = [
        item("user", "hello"),
        item("assistant", "first reply"),
        item("user", "q2"),
        item("assistant", "text one "),
        item("thinking", "t"),
        {
          message: {
            role: "assistant" as const,
            content: "text two",
            id: "id-assistant-text",
            toolCalls: [{ id: "call_1", function: { name: "f" } }],
          },
          contextItems: [],
          toolCallStates: [{ toolCallId: "call_1", status: "generated" }],
        },
      ] as any;

      const repaired = mergeSplitReplies(history);

      expect(repaired).toHaveLength(4);
      const merged = repaired[3];
      expect(merged.message.content).toBe("text one text two");
      expect((merged.message as any).toolCalls).toHaveLength(1);
      expect(merged.toolCallStates).toHaveLength(1);
      expect(merged.toolCallStates?.[0]?.toolCallId).toBe("call_1");
    });

    it("preserves thinking-item signature/redacted/reasoning_details on the merged message", () => {
      const history = [
        item("user", "hello"),
        item("assistant", "first reply"),
        item("user", "q2"),
        item("assistant", "text one "),
        {
          message: {
            role: "thinking" as const,
            content: "thinking text",
            id: "id-thinking",
            signature: "sig_abc",
            redactedThinking: "redacted-data",
            reasoning_details: [{ type: "summary_text", text: "sum" }],
          },
          contextItems: [],
        },
        item("assistant", "text two"),
      ] as any;

      const repaired = mergeSplitReplies(history);
      const merged = repaired[3];
      expect(merged.message.content).toBe("text one text two");
      expect((merged.message as any).signature).toBe("sig_abc");
      expect((merged.message as any).redactedThinking).toBe("redacted-data");
      expect((merged.message as any).reasoning_details).toHaveLength(1);
    });

    it("prependHistoryItems merges bubbles and keeps disk-count accounting", () => {
      const initialState = createInitialState();
      initialState.history = [
        item("user", "u1"),
        item("assistant", "head "),
        item("thinking", "t"),
        item("assistant", "tail"),
        item("user", "u2"),
      ] as any;
      (initialState as any).historyTruncated = true;
      (initialState as any).historyLoadedOffset = 5;
      (initialState as any).historyTotalCount = 9;
      (initialState as any).loadedDiskCount = 5;

      const page = [item("user", "u0"), item("assistant", "older reply")];
      const newState = sessionSlice.reducer(
        initialState as any,
        {
          type: "session/prependHistoryItems",
          payload: {
            items: page,
            hasMore: false,
            newLoadedOffset: 0,
            totalCount: 7,
          },
        } as any,
      );

      // 内存条数可以变（合并 3 条为 1 条，减 2），但磁盘记账 5 + 2 = 7，翻页 offset 正确
      expect(newState.loadedDiskCount).toBe(7);
      expect(newState.history).toHaveLength(5); // 7 - 2（合并掉的条目）
    });

    it("prependHistoryItems uses dontMergeHistoricalReplyBubbles, not dontMergeReplyBubbles", () => {
      // 修复回归：prependHistoryItems 应该用历史开关，而不是流式开关。
      // 流式开关=true（不合并），历史开关=false（合并）→ prepend 仍应合并。
      const initialState = createInitialState();
      initialState.history = [
        item("user", "u1"),
        item("assistant", "head "),
        item("thinking", "t"),
        item("assistant", "tail"),
      ] as any;
      (initialState as any).historyTruncated = true;
      (initialState as any).historyLoadedOffset = 4;
      (initialState as any).historyTotalCount = 6;
      (initialState as any).loadedDiskCount = 4;
      (initialState as any).dontMergeReplyBubbles = true;
      (initialState as any).dontMergeHistoricalReplyBubbles = false;

      const page = [item("user", "u0"), item("assistant", "older reply")];
      const newState = sessionSlice.reducer(
        initialState as any,
        {
          type: "session/prependHistoryItems",
          payload: {
            items: page,
            hasMore: false,
            newLoadedOffset: 0,
            totalCount: 6,
          },
        } as any,
      );

      // 历史开关=false → 第二轮合并：head+t+tail → 1 条
      // 首轮 u0+older reply 不合并（单条 assistant）
      // 总条数：2(page) + 1(u1) + 1(merged) = 4
      // 若错误地用了流式开关(true→不合并)，总条数 = 2 + 1 + 3 = 6
      expect(newState.history).toHaveLength(4);
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe("head tail");
      expect(newState.loadedDiskCount).toBe(6);
    });
  });

  describe("dontMergeReplyBubbles (default: keep split)", () => {
    const item = (role: any, content: string) => ({
      message: { role, content, id: `id-${role}-${content.slice(0, 6)}` },
      contextItems: [],
    });

    const realFlowState = (mergeEnabled: boolean) => ({
      ...createInitialState(),
      dontMergeReplyBubbles: mergeEnabled,
      history: [
        ...createInitialState().history,
        {
          message: {
            role: "assistant" as const,
            content: "",
            id: "placeholder",
          },
          contextItems: [],
        },
      ],
    });

    it("streaming keeps the split when dontMergeReplyBubbles=true (default)", () => {
      // 默认不合并：thinking 之后的 assistant 内容新建条目（原始行为）。
      const chunks = [
        { role: "assistant" as const, content: "你这批帧…`TOKEN" },
        { role: "thinking" as const, content: "Interpreting…" },
        { role: "assistant" as const, content: "` 不参与…" },
      ];
      let state = realFlowState(false) as any;
      for (const c of chunks) {
        state = sessionSlice.reducer(state, {
          type: "session/streamUpdate",
          payload: [c],
        } as any);
      }
      const split = state.history.filter(
        (i: any) => i.message.role === "assistant",
      );
      expect(split).toHaveLength(1); // 合并开启：续接原条目，仅一条

      let state2 = realFlowState(true) as any;
      for (const c of chunks) {
        state2 = sessionSlice.reducer(state2, {
          type: "session/streamUpdate",
          payload: [c],
        } as any);
      }
      const unmerged = state2.history.filter(
        (i: any) => i.message.role === "assistant",
      );
      expect(unmerged).toHaveLength(2); // 默认不合并：拆成两条
    });

    it("newSession does NOT merge when dontMergeHistoricalReplyBubbles=true (default)", () => {
      const initialState = createInitialState();
      (initialState as any).dontMergeHistoricalReplyBubbles = true;
      const splitHistory = [
        item("user", "q1"),
        item("assistant", "first reply"),
        item("user", "q2"),
        item("assistant", "head "),
        item("thinking", "t"),
        item("assistant", "tail"),
      ];

      const newState = sessionSlice.reducer(
        initialState as any,
        {
          type: "session/newSession",
          payload: { history: splitHistory },
        } as any,
      );

      // 原样保留，不合并
      expect(newState.history).toHaveLength(6);
      expect(newState.history[4].message.role).toBe("thinking");
      expect(newState.history[5].message.content).toBe("tail");
    });

    it("setDontMergeReplyBubbles syncs the flag into session state", () => {
      const newState = sessionSlice.reducer(
        createInitialState() as any,
        {
          type: "session/setDontMergeReplyBubbles",
          payload: true,
        } as any,
      );
      expect(newState.dontMergeReplyBubbles).toBe(true);
    });

    it("setDontMergeHistoricalReplyBubbles syncs the flag into session state", () => {
      const newState = sessionSlice.reducer(
        createInitialState() as any,
        {
          type: "session/setDontMergeHistoricalReplyBubbles",
          payload: true,
        } as any,
      );
      expect(newState.dontMergeHistoricalReplyBubbles).toBe(true);
    });

    it("streaming merge and load merge are independent flags", () => {
      // 流式开关=false（合并）但历史开关=true（不合并）:
      // 流式续接发生，但加载不合并。
      const chunks = [
        { role: "assistant" as const, content: "head" },
        { role: "thinking" as const, content: "t" },
        { role: "assistant" as const, content: "tail" },
      ];
      let state = realFlowState(false) as any;
      state.dontMergeHistoricalReplyBubbles = true;
      for (const c of chunks) {
        state = sessionSlice.reducer(state, {
          type: "session/streamUpdate",
          payload: [c],
        } as any);
      }
      const assistants = state.history.filter(
        (i: any) => i.message.role === "assistant",
      );
      // 流式合并开启 → 1 条；历史开关不影响流式
      expect(assistants).toHaveLength(1);
      expect(assistants[0].message.content).toBe("headtail");
    });
  });
});

describe("background streaming (session switch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let callCount = 0;
    mockUuidv4.mockImplementation(() => `bg-uuid-${++callCount}`);
    mockRenderChatMessage.mockImplementation((message: ChatMessage) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return "";
    });
  });

  const createState = () => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history: [
      {
        message: { role: "user" as const, content: "Hello", id: "u1" },
        contextItems: [],
      },
    ] as ChatHistoryItemWithMessageId[],
    isStreaming: false,
    title: "A",
    id: "session-a",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "agent" as const,
    isInEdit: false,
    codeBlockApplyStates: { states: [], curIndex: 0 },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
  });

  it("applyStreamUpdatesToHistory merges chunks into a plain target (cached session)", () => {
    const target = {
      history: [
        {
          message: { role: "user" as const, content: "Hello", id: "u1" },
          contextItems: [],
        },
      ] as ChatHistoryItemWithMessageId[],
    };
    applyStreamUpdatesToHistory(target, [
      { role: "assistant" as const, content: "First" },
    ]);
    applyStreamUpdatesToHistory(target, [
      { role: "assistant" as const, content: "Second" },
    ]);
    expect(target.history).toHaveLength(2);
    expect(target.history[1].message.content).toBe("FirstSecond");
  });

  it("newSession does NOT abort the previous session's streamAborter", () => {
    const state = createState();
    const oldAborter = state.streamAborter;
    const newState = sessionSlice.reducer(state, newSession());
    expect(newState.streamAborter).not.toBe(oldAborter);
    expect(oldAborter.signal.aborted).toBe(false);
  });

  it("restoreCachedSession does NOT abort the previous session's streamAborter", () => {
    const state = createState();
    const oldAborter = state.streamAborter;
    const cached = {
      sessionId: "session-b",
      title: "B",
      history: [],
      mode: "agent" as const,
      symbols: {},
    };
    const newState = sessionSlice.reducer(state, restoreCachedSession(cached));
    expect(newState.streamAborter).not.toBe(oldAborter);
    expect(oldAborter.signal.aborted).toBe(false);
    expect(newState.isStreaming).toBe(false);
  });

  it("restoreCachedSession restores isStreaming from the cached snapshot", () => {
    const state = createState();
    const cached = {
      sessionId: "session-b",
      title: "B",
      history: [],
      mode: "agent" as const,
      symbols: {},
      isStreaming: true,
    };
    const newState = sessionSlice.reducer(state, restoreCachedSession(cached));
    expect(newState.isStreaming).toBe(true);
  });

  it("abortStream aborts all registered stream aborters", () => {
    const state = createState();
    const aborter1 = new AbortController();
    const aborter2 = new AbortController();
    registerStreamAborter(aborter1);
    registerStreamAborter(aborter2);
    try {
      sessionSlice.reducer(state, abortStream());
      expect(aborter1.signal.aborted).toBe(true);
      expect(aborter2.signal.aborted).toBe(true);
    } finally {
      unregisterStreamAborter(aborter1);
      unregisterStreamAborter(aborter2);
    }
  });
});
