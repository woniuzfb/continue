import { isLocalConversationModel } from "./localConversation";

describe("isLocalConversationModel", () => {
  it("matches the Local Provider prefixes", () => {
    expect(isLocalConversationModel({ model: "LLM:foo" })).toBe(true);
    expect(isLocalConversationModel({ model: "openrouter:bar" })).toBe(true);
    expect(isLocalConversationModel({ model: "opencode:bar" })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isLocalConversationModel({ model: "gpt-4o" })).toBe(false);
    expect(isLocalConversationModel({ model: "" })).toBe(false);
    expect(isLocalConversationModel({})).toBe(false);
  });
});
