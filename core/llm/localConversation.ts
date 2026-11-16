/**
 * 方案.md §十三.0/§十三.1: the Local Provider (Continue Local / OpenRouter / OpenCode
 * conversation-keyed) reduced-history contract only applies to these model
 * prefixes. Every other provider (including `gemini:`) must keep the
 * full-history request.
 */
export const LOCAL_CONVERSATION_MODEL_PREFIXES = [
  "LLM:",
  "openrouter:",
  "opencode:",
];

/**
 * Model prefixes that expose a reasoning toggle in the toolbar and default to
 * reasoning disabled unless the user has explicitly toggled reasoning on.
 * Decoupled from `LOCAL_CONVERSATION_MODEL_PREFIXES` so `gemini:` models can
 * share the reasoning toggle/default behavior while still sending full history.
 */
export const REASONING_DEFAULT_DISABLED_MODEL_PREFIXES = [
  ...LOCAL_CONVERSATION_MODEL_PREFIXES,
  "gemini:",
];

export function isLocalConversationModel(
  model:
    | {
        model?: string | null;
      }
    | null
    | undefined,
): boolean {
  const name = model?.model ?? "";
  return LOCAL_CONVERSATION_MODEL_PREFIXES.some((prefix) =>
    name.startsWith(prefix),
  );
}

export function isReasoningDefaultDisabledModel(
  model:
    | {
        model?: string | null;
      }
    | null
    | undefined,
): boolean {
  const name = model?.model ?? "";
  return REASONING_DEFAULT_DISABLED_MODEL_PREFIXES.some((prefix) =>
    name.startsWith(prefix),
  );
}
