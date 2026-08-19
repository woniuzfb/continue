import { ChatMessage, LLMFullCompletionOptions } from "..";
import { testLLM } from "../test/fixtures";
import { ChatDescriber } from "./chatDescriber";

describe("ChatDescriber", () => {
  beforeEach(() => {
    // Reset the prompt to the initial value before each test
    ChatDescriber.prompt =
      "Given the following... please reply with a short summary that is 4-12 words in length, you should summarize what the user is asking for OR what the user is trying to accomplish. You should only respond with the summary, no additional text or explanation, you don't need ending punctuation.\n\n";
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("describe method", () => {
    it("should return undefined if ChatDescriber.prompt is undefined", async () => {
      ChatDescriber.prompt = undefined;

      const result = await ChatDescriber.describe(testLLM, {}, "Test message");

      expect(result).toBeUndefined();
    });

    it("should return undefined if message is empty after cleaning", async () => {
      const message = "   ";

      const result = await ChatDescriber.describe(testLLM, {}, message);

      expect(result).toBeUndefined();
    });

    it("should set completionOptions.maxTokens to 16", async () => {
      const message = "Test message";
      const completionOptions: LLMFullCompletionOptions = { temperature: 0.7 };

      testLLM.chatStreams = [[{ role: "assistant", content: "Test response" }]];

      await ChatDescriber.describe(testLLM, completionOptions, message);

      expect(completionOptions.maxTokens).toBe(ChatDescriber.maxTokens);
    });

    it("should return processed content from the model response", async () => {
      const message = "Test message";
      const modelResponseContent = "Model response content";
      const expectedResult = "Model response content";

      testLLM.chatStreams = [
        [{ role: "assistant", content: modelResponseContent }],
      ];

      const result = await ChatDescriber.describe(testLLM, {}, message);

      expect(result).toBe(expectedResult);
    });

    it("should prepend the first user message from history to the prompt", async () => {
      const message = "Second question";
      const history: ChatMessage[] = [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
      ];

      // REPEAT_LAST_MSG 会把最后一条消息（即标题生成 prompt）原样返回；
      // 下标 = user 消息数 - 1，带历史后为 1，所以需要两组
      testLLM.chatStreams = [[], ["REPEAT_LAST_MSG"]];

      const result = await ChatDescriber.describe(
        testLLM,
        {},
        message,
        history,
      );

      expect(result).toBe(
        ChatDescriber.prompt + "First question" + "\n" + message,
      );
    });

    it("should collapse file_content blocks in the first user message", async () => {
      const message = "What do you think?";
      const history: ChatMessage[] = [
        {
          role: "user",
          content:
            'Look at this:\n<file_content path="src/a.py">\nprint("hi")\n</file_content>\nThen answer',
        },
        { role: "assistant", content: "Answer" },
      ];

      testLLM.chatStreams = [[], ["REPEAT_LAST_MSG"]];

      const result = await ChatDescriber.describe(
        testLLM,
        {},
        message,
        history,
      );

      expect(result).toBe(
        ChatDescriber.prompt +
          "Look at this:\n[file: src/a.py]Then answer" +
          "\n" +
          message,
      );
    });

    it("should propagate error if model.chat throws an error", async () => {
      const message = "Test message";
      const completionOptions: LLMFullCompletionOptions = {};

      testLLM.chatStreams = [["ERROR"]];

      await expect(
        ChatDescriber.describe(testLLM, completionOptions, message),
      ).rejects.toThrow();
    });
  });
});
