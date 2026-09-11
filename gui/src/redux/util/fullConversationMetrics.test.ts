import { describe, expect, it } from "vitest";
import type { RuleWithSource, Tool } from "core";
import {
  CONVERSATION_SUMMARY_SEMANTICS_VERSION,
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  fullConversationConstructionIdentity,
  fullConversationMetricsFromCompileResult,
  fullConversationMetricsFromLegacyDisk,
  legacyDiskContextMetricsFromFullConversation,
  type FullConversationConstructionInputs,
} from "./fullConversationMetrics";

const TOOL: Tool = {
  type: "function",
  function: { name: "read_file", description: "read" },
  displayTitle: "Read file",
  wouldLikeTo: "read a file",
  readonly: true,
  group: "built-in",
};

const RULE = {
  name: "style",
  slug: "style",
  source: "local",
  rule: "Use tabs.",
} as unknown as RuleWithSource;

function inputs(
  overrides: Partial<FullConversationConstructionInputs> = {},
): FullConversationConstructionInputs {
  return {
    modelIdentity: "gpt-4o",
    mode: "chat",
    reasoningEnabled: false,
    effectiveRules: [RULE],
    ruleSettings: { style: "on" } as any,
    effectiveTools: [TOOL],
    systemMessageInputs: "You are an assistant.",
    completionOptionsInputsAffectingMeasurement: {
      model: "gpt-4o",
      maxTokens: 2048,
      contextLength: 200000,
    },
    conversationSummarySemanticsVersion: CONVERSATION_SUMMARY_SEMANTICS_VERSION,
    ...overrides,
  };
}

describe("fullConversationConstructionIdentity", () => {
  it("is stable for equal inputs and independent of key order", () => {
    expect(fullConversationConstructionIdentity(inputs())).toBe(
      fullConversationConstructionIdentity(inputs()),
    );

    const reordered = {
      ...inputs(),
      completionOptionsInputsAffectingMeasurement: {
        contextLength: 200000,
        maxTokens: 2048,
        model: "gpt-4o",
      },
    };
    expect(fullConversationConstructionIdentity(reordered)).toBe(
      fullConversationConstructionIdentity(inputs()),
    );
  });

  it("is the canonical serialization itself, not a digest", () => {
    // This is what makes "a changed input always yields a different identity"
    // true: the comparand carries the input values, so two distinct
    // construction environments cannot collide the way a 32-bit hash can.
    const identity = fullConversationConstructionIdentity(inputs());
    expect(identity).toContain('"modelIdentity":"gpt-4o"');
    expect(identity).toContain('"systemMessageInputs":"You are an assistant."');
    expect(identity).toContain('"maxTokens":2048');
    expect(identity).toContain('"mode":"chat"');
  });

  it("preserves array order, because tools and rules order is an input", () => {
    const second = { ...TOOL, displayTitle: "Write file" };
    const forward = fullConversationConstructionIdentity(
      inputs({ effectiveTools: [TOOL, second] }),
    );
    const reversed = fullConversationConstructionIdentity(
      inputs({ effectiveTools: [second, TOOL] }),
    );
    expect(forward).not.toBe(reversed);
  });

  it("changes for every input the plan lists", () => {
    const base = fullConversationConstructionIdentity(inputs());
    const variants: Partial<FullConversationConstructionInputs>[] = [
      { modelIdentity: "gpt-3.5" },
      { mode: "agent" },
      { reasoningEnabled: true },
      { effectiveRules: [] },
      { ruleSettings: {} as any },
      { effectiveTools: [] },
      { systemMessageInputs: "You are another assistant." },
      {
        completionOptionsInputsAffectingMeasurement: {
          model: "gpt-4o",
          maxTokens: 4096,
          contextLength: 200000,
        },
      },
      {
        completionOptionsInputsAffectingMeasurement: {
          model: "gpt-4o",
          maxTokens: 2048,
          contextLength: 128000,
        },
      },
      { conversationSummarySemanticsVersion: 2 },
    ];

    for (const variant of variants) {
      expect(
        fullConversationConstructionIdentity(inputs(variant)),
        JSON.stringify(variant).slice(0, 60),
      ).not.toBe(base);
    }
  });

  it("ignores an undefined optional field instead of hashing its absence twice", () => {
    // `reasoningEnabled: undefined` means "the model decides"; it must equal a
    // construction where the field is simply not written.
    const withUndefined = { ...inputs(), reasoningEnabled: undefined };
    const withoutField = { ...inputs() };
    delete (withoutField as any).reasoningEnabled;
    expect(fullConversationConstructionIdentity(withUndefined)).toBe(
      fullConversationConstructionIdentity(withoutField),
    );
  });
});

describe("full conversation metrics adapters (transitional, 方案.md §五.16.5)", () => {
  it("maps a compile result into the full snapshot", () => {
    expect(
      fullConversationMetricsFromCompileResult({
        didPrune: true,
        contextPercentage: 0.9,
        inputTokens: 180000,
        contextLength: 200000,
      }),
    ).toEqual({
      inputTokens: 180000,
      contextLength: 200000,
      // 过渡语义：窗口剩余量，Stage 2C 换成扣除输出预留与安全缓冲的可用预算。
      availableTokens: 20000,
      contextPercentage: 0.9,
      exceedsContext: true,
    });
  });

  it("tolerates a compile result without token counts", () => {
    expect(
      fullConversationMetricsFromCompileResult({
        didPrune: false,
        contextPercentage: 0.1,
      }),
    ).toMatchObject({ inputTokens: 0, contextLength: 0, availableTokens: 0 });
  });

  it("round-trips the legacy disk field both ways", () => {
    const legacy = {
      didPrune: false,
      contextPercentage: 0.25,
      inputTokens: 25,
      contextLength: 100,
    };
    const snapshot = fullConversationMetricsFromLegacyDisk(legacy);
    expect(snapshot).toMatchObject({
      inputTokens: 25,
      contextLength: 100,
      contextPercentage: 0.25,
      exceedsContext: false,
    });
    expect(legacyDiskContextMetricsFromFullConversation(snapshot)).toEqual(
      legacy,
    );
  });

  it("keeps undefined undefined", () => {
    expect(fullConversationMetricsFromLegacyDisk(undefined)).toBeUndefined();
    expect(
      legacyDiskContextMetricsFromFullConversation(undefined),
    ).toBeUndefined();
  });

  it("exposes the schema version the gate compares", () => {
    expect(FULL_CONVERSATION_METRICS_SCHEMA_VERSION).toBe(1);
    expect(CONVERSATION_SUMMARY_SEMANTICS_VERSION).toBe(1);
  });
});
