import { describe, expect, it } from "vitest";

import { ChatMessage } from "../index.js";
import { compileChatMessages, countTokens } from "./countTokens.js";

describe("compileChatMessages — excludeToolOutputsFromTokenCount", () => {
  const MODEL = "gpt-4";
  const BIG_TOOL_OUTPUT = "lorem ipsum ".repeat(4000);

  const buildMsgs = (): ChatMessage[] =>
    [
      { role: "user", content: "old question that can be pruned" },
      {
        role: "assistant",
        content: "calling a tool",
        toolCalls: [
          {
            id: "t1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: BIG_TOOL_OUTPUT, toolCallId: "t1" },
      { role: "user", content: "final question" },
    ] as ChatMessage[];

  const compile = (exclude: boolean, knownContextLength: number) =>
    compileChatMessages({
      modelName: MODEL,
      msgs: buildMsgs(),
      knownContextLength,
      maxTokens: 2000,
      supportsImages: true,
      excludeToolOutputsFromTokenCount: exclude,
    });

  const hasToolMessage = (msgs: ChatMessage[]) =>
    msgs.some((m) => m.role === "tool" && m.content === BIG_TOOL_OUTPUT);

  it("subtracts tool-output tokens from inputTokens but still sends them", () => {
    const CL = 200_000; // large window: neither side prunes
    const off = compile(false, CL);
    const on = compile(true, CL);

    expect(off.didPrune).toBe(false);
    expect(on.didPrune).toBe(false);
    expect(on.compiledChatMessages).toEqual(off.compiledChatMessages);
    expect(hasToolMessage(on.compiledChatMessages)).toBe(true);

    const toolContentTokens = countTokens(BIG_TOOL_OUTPUT, MODEL);
    expect(off.inputTokens).toBeDefined();
    expect(on.inputTokens).toBeDefined();
    const delta = off.inputTokens! - on.inputTokens!;
    expect(delta).toBeGreaterThanOrEqual(toolContentTokens);
    expect(delta).toBeLessThanOrEqual(toolContentTokens + 100);
  });

  it("defers pruning: history survives when the tool output is excluded", () => {
    const CL = 6000; // smaller than tool output, larger than the rest
    const off = compile(false, CL);
    const on = compile(true, CL);

    expect(off.didPrune).toBe(true);
    expect(hasToolMessage(off.compiledChatMessages)).toBe(false);

    expect(on.didPrune).toBe(false);
    expect(hasToolMessage(on.compiledChatMessages)).toBe(true);
    expect(
      on.compiledChatMessages.some(
        (m) =>
          m.role === "user" && m.content === "old question that can be pruned",
      ),
    ).toBe(true);
    // NOTE: no inputTokens comparison here — `off` prunes the whole history
    // (including the tool result), collapsing its inputTokens to just the
    // preserved final message, which is SMALLER than `on` (which keeps the
    // history). The meaningful contrast is didPrune + message survival above.
  });
});
