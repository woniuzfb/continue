/**
 * 方案.md §十三.0/§十三.1: the Local Provider (Continue Local / OpenRouter / OpenCode
 * conversation-keyed) contract only applies to these model prefixes. Every
 * other provider must keep the full-history request.
 */
const LOCAL_CONVERSATION_MODEL_PREFIXES = ["LLM:", "openrouter:", "opencode:"];

export function isLocalConversationModel(model: {
  model?: string | null;
}): boolean {
  const name = model?.model ?? "";
  return LOCAL_CONVERSATION_MODEL_PREFIXES.some((prefix) =>
    name.startsWith(prefix),
  );
}
