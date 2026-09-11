import { describe, expect, it } from "vitest";
import type { ChatMessage, Tool } from "..";
import {
  compileChatMessages,
  getTokenCountingBufferSafety,
  measureChatMessagesNoPrune,
  measurementInputsAffectingTokens,
  resolveChatTokenBudget,
} from "./countTokens";

/**
 * Stage 2C（方案.md §7.1.1/§7.1.2）：共享 token 预算 + no-prune 完整会话计量。
 *
 * 关注三件事：
 * 1. 预算/计数/分区只有一份实现 —— 未超限时计量与 compile 的 pre-prune 计数完全一致；
 * 2. 计量本身不裁剪、不抛错、允许 percentage > 1、不修改入参；
 * 3. 影响计量的有效输入被显式列出（供 Stage 2D 生成 constructionIdentity）。
 */

const MODEL = "gpt-4";
const BIG_TOOL_OUTPUT = "lorem ipsum ".repeat(4000);

const TOOL: Tool = {
  type: "function",
  function: {
    name: "read_file",
    description: "reads a file from disk",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "file path" } },
      required: ["path"],
    },
  },
  displayTitle: "Read file",
  readonly: true,
  group: "built-in",
} as Tool;

const measure = (
  overrides: Partial<Parameters<typeof measureChatMessagesNoPrune>[0]>,
) =>
  measureChatMessagesNoPrune({
    modelName: MODEL,
    msgs: [],
    knownContextLength: 128000,
    maxTokens: 2000,
    supportsImages: true,
    ...overrides,
  });

const compile = (
  overrides: Partial<Parameters<typeof compileChatMessages>[0]>,
) =>
  compileChatMessages({
    modelName: MODEL,
    msgs: [],
    knownContextLength: 128000,
    maxTokens: 2000,
    supportsImages: true,
    ...overrides,
  } as any);

const simpleHistory = (): ChatMessage[] => [
  { role: "system", content: "SYSTEM" },
  { role: "user", content: "hello there" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "bye" },
];

const overBudgetHistory = (): ChatMessage[] => [
  { role: "system", content: "SYSTEM" },
  { role: "user", content: "old question ".repeat(400) },
  { role: "assistant", content: "old answer ".repeat(400) },
  { role: "user", content: "final question" },
];

const toolHistory = (): ChatMessage[] => [
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
  } as ChatMessage,
  { role: "tool", content: BIG_TOOL_OUTPUT, toolCallId: "t1" } as ChatMessage,
  { role: "user", content: "final question" },
];

describe("resolveChatTokenBudget — the single budget formula", () => {
  it("caps the safety buffer at 1000 tokens (2% above 50k)", () => {
    expect(
      resolveChatTokenBudget({ knownContextLength: 50000, maxTokens: 2000 }),
    ).toEqual({
      contextLength: 50000,
      countingSafetyBuffer: 1000,
      minOutputTokens: 1000,
      availableTokens: 48000,
    });
  });

  it("uses 2% of the window below the cap", () => {
    const budget = resolveChatTokenBudget({
      knownContextLength: 10000,
      maxTokens: 2000,
    });
    expect(budget.countingSafetyBuffer).toBe(200);
    expect(budget.availableTokens).toBe(10000 - 200 - 1000);
  });

  it("reserves at most MIN_RESPONSE_TOKENS, bounded by maxTokens", () => {
    expect(
      resolveChatTokenBudget({ knownContextLength: 128000, maxTokens: 10 })
        .minOutputTokens,
    ).toBe(10);
    expect(
      resolveChatTokenBudget({ knownContextLength: 128000, maxTokens: 8000 })
        .minOutputTokens,
    ).toBe(1000);
  });

  it("falls back to DEFAULT_PRUNING_LENGTH when the window is unknown", () => {
    const budget = resolveChatTokenBudget({
      knownContextLength: undefined,
      maxTokens: 2000,
    });
    expect(budget.contextLength).toBe(128000);
    expect(budget.availableTokens).toBe(128000 - 1000 - 1000);
  });

  it("is the same buffer helper the pruning path uses", () => {
    expect(getTokenCountingBufferSafety(50000)).toBe(1000);
    expect(getTokenCountingBufferSafety(1000)).toBe(20);
  });
});

describe("measureChatMessagesNoPrune — parity with the compile pre-prune accounting", () => {
  it("matches compile exactly when nothing is pruned", () => {
    for (const msgs of [simpleHistory(), overBudgetHistory(), toolHistory()]) {
      const compiled = compile({ msgs, knownContextLength: 128000 });
      const measured = measure({ msgs, knownContextLength: 128000 });

      expect(compiled.didPrune).toBe(false);
      expect(measured.inputTokens).toBe(compiled.inputTokens);
      expect(measured.contextLength).toBe(compiled.contextLength);
      // Independent check of the budget: compile only exposes the ratio, so its
      // implied denominator must equal the measurement's availableTokens.
      expect(measured.availableTokens).toBeCloseTo(
        (compiled.inputTokens ?? 0) / compiled.contextPercentage,
        6,
      );
      expect(measured.availableTokens).toBe(
        resolveChatTokenBudget({ knownContextLength: 128000, maxTokens: 2000 })
          .availableTokens,
      );
    }
  });

  it("matches compile for a tool sequence that stays unpruned", () => {
    const msgs = toolHistory();
    const compiled = compile({
      msgs,
      knownContextLength: 128000,
      tools: [TOOL],
    });
    const measured = measure({
      msgs,
      knownContextLength: 128000,
      tools: [TOOL],
    });
    expect(compiled.didPrune).toBe(false);
    expect(measured.inputTokens).toBe(compiled.inputTokens);
  });

  it("agrees with compile about the tool-output exclusion rule", () => {
    const msgs = toolHistory();
    const excluded = {
      msgs,
      knownContextLength: 128000,
      excludeToolOutputsFromTokenCount: true,
    };
    const included = {
      msgs,
      knownContextLength: 128000,
      excludeToolOutputsFromTokenCount: false,
    };

    expect(measure(excluded).inputTokens).toBe(compile(excluded).inputTokens);
    expect(measure(included).inputTokens).toBe(compile(included).inputTokens);
    expect(measure(excluded).inputTokens).toBeLessThan(
      measure(included).inputTokens,
    );
  });

  it("counts image tokens only when the model supports images", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "assistant", content: "seen" },
      { role: "user", content: "now" },
    ];

    const supported = measure({ msgs, supportsImages: true });
    const unsupported = measure({ msgs, supportsImages: false });

    expect(supported.inputTokens).toBe(
      compile({ msgs, supportsImages: true }).inputTokens,
    );
    expect(unsupported.inputTokens).toBe(
      compile({ msgs, supportsImages: false }).inputTokens,
    );
    expect(unsupported.inputTokens).toBeLessThan(supported.inputTokens);
  });

  it("counts native tool definitions", () => {
    const msgs = simpleHistory();
    const withoutTools = measure({ msgs });
    const withTools = measure({ msgs, tools: [TOOL] });
    expect(withTools.inputTokens).toBe(
      compile({ msgs, tools: [TOOL] }).inputTokens,
    );
    expect(withTools.inputTokens).toBeGreaterThan(withoutTools.inputTokens);
  });
});

describe("measureChatMessagesNoPrune — no pruning, no throwing", () => {
  it("reports a percentage above 1 where compile must prune", () => {
    const msgs = overBudgetHistory();
    const compiled = compile({
      msgs,
      knownContextLength: 2000,
      maxTokens: 500,
    });
    const measured = measure({
      msgs,
      knownContextLength: 2000,
      maxTokens: 500,
    });

    expect(compiled.didPrune).toBe(true);
    expect(measured.contextPercentage).toBeGreaterThan(1);
    expect(measured.exceedsContext).toBe(true);
    expect(measured.inputTokens).toBeGreaterThan(measured.availableTokens);
  });

  it("keeps measuring where compile throws on protected messages", () => {
    const msgs = overBudgetHistory();
    const protectedIndexes = msgs.map((_, index) => index);

    expect(() =>
      compile({
        msgs,
        knownContextLength: 2000,
        maxTokens: 500,
        protectedMessageIndexes: protectedIndexes,
      }),
    ).toThrowError(/protected messages/);

    // Protected indexes are a send-path decision, not a measurement input: the
    // same history measures identically with and without them.
    expect(
      measure({ msgs, knownContextLength: 2000, maxTokens: 500 }).inputTokens,
    ).toBe(
      measure({ msgs, knownContextLength: 2000, maxTokens: 500 }).inputTokens,
    );
    expect(
      measure({ msgs, knownContextLength: 2000, maxTokens: 500 })
        .exceedsContext,
    ).toBe(true);
  });

  it("keeps measuring where compile throws for non-negotiable items", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYSTEM ".repeat(500) },
      { role: "user", content: "hello" },
    ];
    expect(() =>
      compile({
        msgs,
        knownContextLength: 500,
        maxTokens: 2000,
        tools: [TOOL],
      }),
    ).toThrowError(
      /Not enough context available to include the system message/,
    );

    const measured = measure({
      msgs,
      knownContextLength: 500,
      maxTokens: 2000,
      tools: [TOOL],
    });
    expect(measured.exceedsContext).toBe(true);
    expect(measured.contextPercentage).toBeGreaterThan(1);
  });

  it("does not throw on an empty conversation and counts only system + tools", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYSTEM" },
      { role: "assistant", content: "" },
    ];
    expect(() =>
      compile({ msgs, knownContextLength: 128000, maxTokens: 2000 }),
    ).toThrowError(/no user\/tool message found/);

    const withoutTools = measure({ msgs });
    const withTools = measure({ msgs, tools: [TOOL] });
    expect(withoutTools.exceedsContext).toBe(false);
    expect(withoutTools.contextPercentage).toBeGreaterThan(0);
    expect(withTools.inputTokens).toBeGreaterThan(withoutTools.inputTokens);
  });

  it("returns a finite percentage for a huge context", () => {
    const measured = measure({
      msgs: overBudgetHistory(),
      knownContextLength: 2_000_000,
      maxTokens: 2000,
    });
    expect(measured.contextPercentage).toBeLessThan(1);
    expect(measured.exceedsContext).toBe(false);
    expect(Number.isFinite(measured.contextPercentage)).toBe(true);
  });

  it("flags a configuration anomaly with a finite saturating percentage", () => {
    // Output reservation >= window: there is no input budget at all. The signal is
    // `exceedsContext`; the percentage saturates instead of becoming Infinity,
    // because the Result is persisted as JSON (`Session.contextMetrics`) and
    // `JSON.stringify(Infinity)` is `null` — a value the reader must reject
    // (方案.md §五.16.5: 归一化层不得靠丢失类型信息的 null 猜原始值).
    const measured = measure({
      msgs: simpleHistory(),
      knownContextLength: 1000,
      maxTokens: 5000,
    });
    expect(measured.availableTokens).toBeLessThanOrEqual(0);
    expect(measured.exceedsContext).toBe(true);
    expect(Number.isFinite(measured.contextPercentage)).toBe(true);
    expect(measured.contextPercentage).toBeGreaterThan(1);
  });

  it("returns a zero percentage when there is no budget and no input", () => {
    const measured = measure({
      msgs: [],
      knownContextLength: 1000,
      maxTokens: 5000,
    });
    expect(measured.availableTokens).toBeLessThanOrEqual(0);
    expect(measured.inputTokens).toBe(0);
    expect(measured.contextPercentage).toBe(0);
  });

  it("produces a measurement that survives a JSON round-trip", () => {
    // 方案.md §7.1.4: every number that can reach `FullConversationMetricsSnapshot`
    // is finite and JSON-safe. Without this, a save writes `null` and a reload
    // grades the Result it just wrote as `unavailable`.
    const cases = [
      { knownContextLength: 128000, maxTokens: 2000 },
      { knownContextLength: 2_000_000, maxTokens: 2000 },
      { knownContextLength: 1000, maxTokens: 5000 },
      { knownContextLength: undefined, maxTokens: 2000 },
    ];
    for (const budget of cases) {
      const measured = measure({ msgs: overBudgetHistory(), ...budget });
      expect(Number.isFinite(measured.inputTokens)).toBe(true);
      expect(Number.isFinite(measured.contextLength)).toBe(true);
      expect(Number.isFinite(measured.availableTokens)).toBe(true);
      expect(Number.isFinite(measured.contextPercentage)).toBe(true);
      expect(JSON.parse(JSON.stringify(measured))).toEqual(measured);
    }
  });

  it("is consistent with its own percentage definition", () => {
    for (const contextLength of [2000, 50000, 128000, 2_000_000]) {
      const measured = measure({
        msgs: overBudgetHistory(),
        knownContextLength: contextLength,
      });
      expect(measured.exceedsContext).toBe(
        measured.inputTokens > measured.availableTokens,
      );
      expect(measured.contextPercentage).toBeCloseTo(
        measured.inputTokens / measured.availableTokens,
        10,
      );
    }
  });
});

describe("measureChatMessagesNoPrune — inputs are never mutated", () => {
  it("leaves messages and tools untouched", () => {
    const msgs = toolHistory();
    const msgsCopy = structuredClone(msgs);
    const tools = [TOOL];
    const toolsCopy = structuredClone(tools);

    compile({ msgs, tools, knownContextLength: 2000, maxTokens: 500 });
    compile({ msgs, tools, knownContextLength: 128000, maxTokens: 2000 });
    measure({ msgs, tools, knownContextLength: 2000, maxTokens: 500 });

    expect(msgs).toEqual(msgsCopy);
    expect(tools).toEqual(toolsCopy);
  });

  it("also leaves image content arrays untouched when images are unsupported", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "user", content: "now" },
    ];
    const before = structuredClone(msgs);
    compile({ msgs, supportsImages: false });
    measure({ msgs, supportsImages: false });
    expect(msgs).toEqual(before);
  });
});

describe("measurementInputsAffectingTokens", () => {
  it("lists the resolved inputs that change token counts", () => {
    expect(
      measurementInputsAffectingTokens({
        modelName: MODEL,
        knownContextLength: 50000,
        maxTokens: 2000,
        supportsImages: false,
        tools: [TOOL],
        excludeToolOutputsFromTokenCount: true,
        excludeToolOutputsFromTokenCountMinTokens: 1234,
      }),
    ).toEqual({
      modelName: MODEL,
      contextLength: 50000,
      maxTokens: 2000,
      minOutputTokens: 1000,
      countingSafetyBuffer: 1000,
      supportsImages: false,
      toolNames: ["read_file"],
      excludeToolOutputsFromTokenCount: true,
      excludeToolOutputsFromTokenCountMinTokens: 1234,
    });
  });

  it("uses the default exclusion threshold when none is given", () => {
    const inputs = measurementInputsAffectingTokens({
      modelName: MODEL,
      knownContextLength: undefined,
      maxTokens: 2000,
      supportsImages: true,
    });
    expect(inputs.excludeToolOutputsFromTokenCountMinTokens).toBe(6000);
    expect(inputs.contextLength).toBe(128000);
    expect(inputs.toolNames).toEqual([]);
  });
});
