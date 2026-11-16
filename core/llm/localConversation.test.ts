import {
  isLocalConversationModel,
  isReasoningDefaultDisabledModel,
} from "./localConversation";

describe("isLocalConversationModel", () => {
  it("matches the Local Provider reduced-history prefixes", () => {
    expect(isLocalConversationModel({ model: "LLM:foo" })).toBe(true);
    expect(isLocalConversationModel({ model: "openrouter:bar" })).toBe(true);
    expect(isLocalConversationModel({ model: "opencode:bar" })).toBe(true);
  });

  it("rejects gemini: and other full-history models", () => {
    expect(
      isLocalConversationModel({ model: "gemini:app/gemini-4-argon-high" }),
    ).toBe(false);
    expect(isLocalConversationModel({ model: "gpt-4o" })).toBe(false);
    expect(isLocalConversationModel({ model: "" })).toBe(false);
    expect(isLocalConversationModel({})).toBe(false);
  });
});

describe("isReasoningDefaultDisabledModel", () => {
  it("matches LLM:, openrouter:, opencode:, and gemini: prefixes", () => {
    expect(isReasoningDefaultDisabledModel({ model: "LLM:foo" })).toBe(true);
    expect(isReasoningDefaultDisabledModel({ model: "openrouter:bar" })).toBe(
      true,
    );
    expect(isReasoningDefaultDisabledModel({ model: "opencode:bar" })).toBe(
      true,
    );
    expect(
      isReasoningDefaultDisabledModel({
        model: "gemini:app/gemini-4-argon-high",
      }),
    ).toBe(true);
  });

  it("rejects other models", () => {
    expect(isReasoningDefaultDisabledModel({ model: "gpt-4o" })).toBe(false);
    expect(isReasoningDefaultDisabledModel({ model: "" })).toBe(false);
    expect(isReasoningDefaultDisabledModel({})).toBe(false);
  });
});
