import { describe, expect, it } from "vitest";
import type { RuleWithSource, Tool } from "..";
import {
  CONVERSATION_SUMMARY_SEMANTICS_VERSION,
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  fullConversationConstructionIdentity,
  type FullConversationConstructionInputs,
} from "./fullConversationMetrics";

/**
 * 共享契约的 identity 部分（方案.md §五.16.2 / §五.16.5）。Stage 2D 起 GUI 与 Core
 * 共用同一份实现，测试因此跟着契约走：这里固定 canonical 序列化的**性质**
 * （键序无关、值变化必变、undefined 忽略、数组顺序保留、逐输入覆盖），
 * 而不是任何哈希值 —— 身份就是 canonical 序列化本身，不做摘要。
 */

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
