import {
  stripImages,
  renderChatMessage,
  renderContextItems,
  normalizeToMessageParts,
  stripRuntimeMessageIdsForProvider,
} from "./messageContent.js";
import {
  AssistantChatMessage,
  ChatMessage,
  ContextItem,
  MessageContent,
  MessagePart,
  ToolResultChatMessage,
} from "../index.js";

describe("messageContent utility functions", () => {
  describe("stripImages", () => {
    it("should return the string as is if messageContent is a string", () => {
      const content: MessageContent = "This is a test message.";
      expect(stripImages(content)).toBe("This is a test message.");
    });

    it("should strip out image parts and join text parts of a message", () => {
      const content: MessageContent = [
        { type: "text", text: "This is" },
        {
          type: "imageUrl",
          imageUrl: { url: "http://example.com/image1.png" },
        },
        { type: "text", text: "a test message." },
      ];
      expect(stripImages(content)).toBe("This is\na test message.");
    });
  });

  describe("renderChatMessage", () => {
    it("should render user, assistant, or system messages with stripped image content", () => {
      const message: ChatMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Hello," },
          {
            type: "imageUrl",
            imageUrl: { url: "http://example.com/image.png" },
          },
          { type: "text", text: "world!" },
        ],
      };
      expect(renderChatMessage(message)).toBe("Hello,\nworld!");
    });

    it("should render tool messages as is", () => {
      const message: ChatMessage = {
        role: "tool",
        content: "Command output message",
        toolCallId: "1",
      };
      expect(renderChatMessage(message)).toBe("Command output message");
    });
  });

  describe("renderContextItems", () => {
    it("should concatenate the content of context items with two newlines", () => {
      const items: ContextItem[] = [
        {
          content: "Context Item 1",
          name: "Item1",
          description: "Description1",
        },
        {
          content: "Context Item 2",
          name: "Item2",
          description: "Description2",
        },
      ];
      expect(renderContextItems(items)).toBe(
        "Context Item 1\n\nContext Item 2",
      );
    });
  });

  describe("normalizeToMessageParts", () => {
    it("should normalize user, assistant, or system messages to MessagePart array", () => {
      const message: ChatMessage = {
        role: "user",
        content: "This is a test message.",
      };
      const expected: MessagePart[] = [
        { type: "text", text: "This is a test message." },
      ];
      expect(normalizeToMessageParts(message)).toEqual(expected);
    });

    it("should normalize tool messages to MessagePart array", () => {
      const message: ChatMessage = {
        role: "tool",
        content: "Tool message content",
        toolCallId: "1",
      };
      const expected: MessagePart[] = [
        { type: "text", text: "Tool message content" },
      ];
      expect(normalizeToMessageParts(message)).toEqual(expected);
    });
  });

  describe("stripRuntimeMessageIdsForProvider", () => {
    it("removes the persisted message.id without mutating the input", () => {
      const message: ChatMessage = {
        role: "user",
        content: "hello",
        id: "persisted-1",
      };

      const stripped = stripRuntimeMessageIdsForProvider([message]);

      expect(stripped[0]).not.toHaveProperty("id");
      // The input object must be untouched — persistence still needs the id.
      expect((message as { id?: string }).id).toBe("persisted-1");
      expect(message).toHaveProperty("id", "persisted-1");
    });

    it("keeps provider-level ids: tool call id, toolCallId, reasoning id, metadata", () => {
      const assistant: ChatMessage = {
        role: "assistant",
        content: "",
        id: "persisted-assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
        metadata: { reasoning_id: "reasoning-1", providerField: 42 },
      };
      const toolResult: ChatMessage = {
        role: "tool",
        content: "file contents",
        toolCallId: "call-1",
        id: "persisted-tool",
      };
      const thinking: ChatMessage = {
        role: "thinking",
        content: "thinking...",
        id: "persisted-thinking",
        reasoning_details: [{ signature: "sig-1" }],
      };

      const [strippedAssistant, strippedTool, strippedThinking] =
        stripRuntimeMessageIdsForProvider([assistant, toolResult, thinking]);

      expect(strippedAssistant).not.toHaveProperty("id");
      expect(strippedTool).not.toHaveProperty("id");
      expect(strippedThinking).not.toHaveProperty("id");

      const a = strippedAssistant as AssistantChatMessage;
      expect(a.toolCalls?.[0].id).toBe("call-1");
      expect(a.metadata?.reasoning_id).toBe("reasoning-1");
      expect(a.metadata?.providerField).toBe(42);

      const t = strippedTool as ToolResultChatMessage;
      expect(t.toolCallId).toBe("call-1");

      expect(
        (strippedThinking as ChatMessage & { reasoning_details?: unknown[] })
          .reasoning_details,
      ).toEqual([{ signature: "sig-1" }]);
    });

    it("supports every ChatMessage variant in one array", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "u", id: "id-user" },
        { role: "assistant", content: "a", id: "id-assistant" },
        { role: "thinking", content: "t", id: "id-thinking" },
        { role: "system", content: "s", id: "id-system" },
        { role: "tool", content: "o", toolCallId: "c", id: "id-tool" },
      ];

      const stripped = stripRuntimeMessageIdsForProvider(messages);

      expect(stripped).toHaveLength(messages.length);
      stripped.forEach((message) => expect(message).not.toHaveProperty("id"));
    });

    it("is a no-op for legacy messages without ids and never mints one", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "hi" },
        { role: "system", content: "sys" },
        { role: "assistant", content: "asst" },
        { role: "tool", content: "tool out", toolCallId: "c" },
      ];

      const stripped = stripRuntimeMessageIdsForProvider(messages);

      expect(stripped).toEqual(messages);
      stripped.forEach((message) => expect(message).not.toHaveProperty("id"));
    });
  });
});
