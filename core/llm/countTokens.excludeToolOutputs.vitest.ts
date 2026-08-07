import { describe, expect, it } from "vitest";

import { ChatMessage } from "../index.js";
import {
  compileChatMessages,
  countLargeToolOutputTokens,
  countTokens,
} from "./countTokens.js";

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

describe("compileChatMessages — excludeToolOutputsFromTokenCountMinTokens", () => {
  const MODEL = "gpt-4";
  const SMALL_TOOL_OUTPUT = "lorem ipsum ".repeat(1000); // ~3K tokens
  const BIG_TOOL_OUTPUT = "lorem ipsum ".repeat(4000); // ~12K tokens

  const buildMsgs = (toolOutput: string): ChatMessage[] =>
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
      { role: "tool", content: toolOutput, toolCallId: "t1" },
      { role: "user", content: "final question" },
    ] as ChatMessage[];

  const compile = (
    toolOutput: string,
    opts: {
      exclude?: boolean;
      minTokens?: number;
      knownContextLength?: number;
    } = {},
  ) =>
    compileChatMessages({
      modelName: MODEL,
      msgs: buildMsgs(toolOutput),
      knownContextLength: opts.knownContextLength ?? 200_000,
      maxTokens: 2000,
      supportsImages: true,
      excludeToolOutputsFromTokenCount: opts.exclude,
      excludeToolOutputsFromTokenCountMinTokens: opts.minTokens,
    });

  it("default threshold (6000): small tool output is counted normally", () => {
    // Small output (< 6000 tokens) should be counted even when exclude=true
    const off = compile(SMALL_TOOL_OUTPUT, { exclude: false });
    const on = compile(SMALL_TOOL_OUTPUT, { exclude: true });

    expect(off.didPrune).toBe(false);
    expect(on.didPrune).toBe(false);
    expect(on.compiledChatMessages).toEqual(off.compiledChatMessages);
    // Small tool output is NOT excluded -> inputTokens unchanged
    expect(on.inputTokens).toBe(off.inputTokens);
  });

  it("default threshold (6000): big tool output is excluded", () => {
    // Big output (> 6000 tokens) should be excluded when exclude=true
    const off = compile(BIG_TOOL_OUTPUT, { exclude: false });
    const on = compile(BIG_TOOL_OUTPUT, { exclude: true });

    expect(off.didPrune).toBe(false);
    expect(on.didPrune).toBe(false);

    const toolContentTokens = countTokens(BIG_TOOL_OUTPUT, MODEL);
    const delta = off.inputTokens! - on.inputTokens!;
    expect(delta).toBeGreaterThanOrEqual(toolContentTokens);
    expect(delta).toBeLessThanOrEqual(toolContentTokens + 100);
  });

  it("custom threshold lower than small output: small output gets excluded", () => {
    // Lower the threshold below the small output size so it also gets excluded
    const off = compile(SMALL_TOOL_OUTPUT, { exclude: false });
    const on = compile(SMALL_TOOL_OUTPUT, {
      exclude: true,
      minTokens: 1000,
    });

    expect(off.didPrune).toBe(false);
    expect(on.didPrune).toBe(false);

    const toolContentTokens = countTokens(SMALL_TOOL_OUTPUT, MODEL);
    const delta = off.inputTokens! - on.inputTokens!;
    expect(delta).toBeGreaterThanOrEqual(toolContentTokens);
    expect(delta).toBeLessThanOrEqual(toolContentTokens + 100);
  });

  it("custom threshold higher than big output: big output is counted normally", () => {
    // Raise the threshold above the big output size so nothing is excluded
    const off = compile(BIG_TOOL_OUTPUT, { exclude: false });
    const on = compile(BIG_TOOL_OUTPUT, { exclude: true, minTokens: 20_000 });

    expect(off.didPrune).toBe(false);
    expect(on.didPrune).toBe(false);
    expect(on.inputTokens).toBe(off.inputTokens);
  });

  it("boundary band: threshold uses FULL message tokens, matching the logEnd helper", () => {
    // Content alone is BELOW the threshold, but content + wrapper tokens
    // (base/extra/toolCallId) cross it. Counting only content — the old
    // _countToolOutputTokens behavior — would treat this output as counted
    // while the pruning budget treats it as free: the inconsistency this
    // fix removes.
    const content = "lorem ipsum ".repeat(1000); // ~3K tokens
    const contentTokens = countTokens(content, MODEL);
    const minTokens = contentTokens + 1; // content-only would NOT exclude
    expect(contentTokens).toBeLessThan(minTokens);

    const msgs = buildMsgs(content);
    const excluded = countLargeToolOutputTokens(msgs, MODEL, minTokens);
    // Full message count (content + wrappers) crosses the threshold
    expect(excluded).toBeGreaterThan(0);

    // The pruning budget agrees: dropping the tool message reduces
    // inputTokens by EXACTLY the helper's excluded amount, because both
    // count via countChatMessageTokens.
    const off = compile(content, { exclude: false, minTokens });
    const on = compile(content, { exclude: true, minTokens });
    const delta = off.inputTokens! - on.inputTokens!;
    expect(delta).toBe(excluded);
  });
});
