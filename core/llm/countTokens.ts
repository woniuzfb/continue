import { Tiktoken, encodingForModel as _encodingForModel } from "js-tiktoken";

import {
  ChatMessage,
  CompiledMessagesResult,
  MessageContent,
  MessagePart,
  Tool,
} from "../index.js";
import { autodetectTemplateType } from "./autodetect.js";
import {
  addSpaceToAnyEmptyMessages,
  chatMessageIsEmpty,
  messageHasToolCallId,
} from "./messages.js";

import {
  renderChatMessage,
  replaceFileContentBlocks,
  stripInlineImageBase64,
} from "../util/messageContent.js";
import { AsyncEncoder, LlamaAsyncEncoder } from "./asyncEncoder.js";
import { DEFAULT_PRUNING_LENGTH } from "./constants.js";
import { getAdjustedTokenCountFromModel } from "./getAdjustedTokenCount.js";
import llamaTokenizer from "./llamaTokenizer.js";

interface Encoding {
  encode: Tiktoken["encode"];
  decode: Tiktoken["decode"];
}

class LlamaEncoding implements Encoding {
  encode(text: string): number[] {
    return llamaTokenizer.encode(text);
  }

  decode(tokens: number[]): string {
    return llamaTokenizer.decode(tokens);
  }
}

class NonWorkerAsyncEncoder implements AsyncEncoder {
  constructor(private readonly encoding: Encoding) {}

  async close(): Promise<void> {}

  async encode(text: string): Promise<number[]> {
    return this.encoding.encode(text);
  }

  async decode(tokens: number[]): Promise<string> {
    return this.encoding.decode(tokens);
  }
}

let gptEncoding: Encoding | null = null;
const llamaEncoding = new LlamaEncoding();
const llamaAsyncEncoder = new LlamaAsyncEncoder();

function asyncEncoderForModel(modelName: string): AsyncEncoder {
  // Temporary due to issues packaging the worker files
  if (process.env.IS_BINARY) {
    const encoding = encodingForModel(modelName);
    return new NonWorkerAsyncEncoder(encoding);
  }

  const modelType = autodetectTemplateType(modelName);
  if (!modelType || modelType === "none") {
    // Right now there is a problem packaging js-tiktoken in workers. Until then falling back
    // Cannot find package 'js-tiktoken' imported from /Users/nate/gh/continuedev/continue/extensions/vscode/out/tiktokenWorkerPool.mjs
    // return gptAsyncEncoder;
    return llamaAsyncEncoder;
  }
  return llamaAsyncEncoder;
}

function encodingForModel(modelName: string): Encoding {
  const modelType = autodetectTemplateType(modelName);

  if (!modelType || modelType === "none") {
    if (!gptEncoding) {
      gptEncoding = _encodingForModel("gpt-4");
    }

    return gptEncoding;
  }

  return llamaEncoding;
}

function countImageTokens(content: MessagePart): number {
  if (content.type === "imageUrl") {
    return 1024;
  }
  throw new Error("Non-image content type");
}

async function countTokensAsync(
  content: MessageContent,
  // defaults to llama2 because the tokenizer tends to produce more tokens
  modelName = "llama2",
): Promise<number> {
  const encoding = asyncEncoderForModel(modelName);
  if (Array.isArray(content)) {
    const promises = content.map(async (part) => {
      if (part.type === "imageUrl") {
        return countImageTokens(part);
      }
      return (
        await encoding.encode(
          stripInlineImageBase64(replaceFileContentBlocks(part.text ?? "")),
        )
      ).length;
    });
    return (await Promise.all(promises)).reduce((sum, val) => sum + val, 0);
  }
  return (
    await encoding.encode(
      stripInlineImageBase64(replaceFileContentBlocks(content ?? "")),
    )
  ).length;
}

function countTokens(
  content: MessageContent,
  // defaults to llama2 because the tokenizer tends to produce more tokens
  modelName = "llama2",
): number {
  const encoding = encodingForModel(modelName);
  let baseTokens = 0;
  if (Array.isArray(content)) {
    baseTokens = content.reduce((acc, part) => {
      return (
        acc +
        (part.type === "text"
          ? encoding.encode(
              stripInlineImageBase64(replaceFileContentBlocks(part.text ?? "")),
              "all",
              [],
            ).length
          : countImageTokens(part))
      );
    }, 0);
  } else {
    baseTokens = encoding.encode(
      stripInlineImageBase64(replaceFileContentBlocks(content ?? "")),
      "all",
      [],
    ).length;
  }
  return getAdjustedTokenCountFromModel(baseTokens, modelName);
}

// https://community.openai.com/t/how-to-calculate-the-tokens-when-using-function-call/266573/10
function countToolsTokens(tools: Tool[], modelName: string): number {
  const count = (value: string) =>
    encodingForModel(modelName).encode(value).length;

  let numTokens = 12;

  for (const tool of tools) {
    let functionTokens = count(tool.function.name);
    if (tool.function.description) {
      functionTokens += count(tool.function.description);
    }
    const props = tool.function.parameters?.properties;
    if (props) {
      for (const key in props) {
        functionTokens += count(key);
        const fields = props[key];
        if (fields) {
          const fieldType = fields["type"];
          const fieldDesc = fields["description"];
          const fieldEnum = fields["enum"];
          if (fieldType && typeof fieldType === "string") {
            functionTokens += 2;
            functionTokens += count(fieldType);
          }
          if (fieldDesc && typeof fieldDesc === "string") {
            functionTokens += 2;
            functionTokens += count(fieldDesc);
          }
          if (fieldEnum && Array.isArray(fieldEnum)) {
            functionTokens -= 3;
            for (const e of fieldEnum) {
              functionTokens += 3;
              functionTokens += typeof e === "string" ? count(e) : 5;
            }
          }
        }
      }
    }
    numTokens += functionTokens;
  }

  return numTokens + 12;
}

function countChatMessageTokens(
  modelName: string,
  chatMessage: ChatMessage,
): number {
  // Doing simpler, safer version of what is here:
  // https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
  // every message follows <|im_start|>{role/name}\n{content}<|end|>\n
  const BASE_TOKENS = 4;
  const TOOL_CALL_EXTRA_TOKENS = 10;
  const TOOL_OUTPUT_EXTRA_TOKENS = 10;
  let tokens = BASE_TOKENS;

  if (chatMessage.content) {
    tokens += countTokens(chatMessage.content, modelName);
  }

  if ("toolCalls" in chatMessage && chatMessage.toolCalls) {
    for (const call of chatMessage.toolCalls) {
      tokens += TOOL_CALL_EXTRA_TOKENS;
      tokens += countTokens(JSON.stringify(call), modelName); // TODO hone this
    }
  }

  if (chatMessage.role === "thinking") {
    if (chatMessage.redactedThinking) {
      tokens += countTokens(chatMessage.redactedThinking, modelName);
    }
    if (chatMessage.signature) {
      tokens += countTokens(chatMessage.signature, modelName);
    }
  }

  if (chatMessage.role === "tool") {
    tokens += TOOL_OUTPUT_EXTRA_TOKENS; // safety
    if (chatMessage.toolCallId) {
      tokens += countTokens(chatMessage.toolCallId, modelName);
    }
  }
  return tokens;
}

/**
 * Sum the FULL message token counts (content + wrappers, via
 * countChatMessageTokens) of `tool`-role messages whose count exceeds
 * `minTokens`. Shared by compileChatMessages (pruning budget / metrics) and
 * BaseLLM._countToolOutputTokens (recorded prompt token usage) so both sides
 * agree on exactly which tool outputs are treated as free and by how much.
 */
export function countLargeToolOutputTokens(
  messages: ChatMessage[],
  modelName: string,
  minTokens: number,
): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role !== "tool") {
      continue;
    }
    const tokens = countChatMessageTokens(modelName, msg);
    if (tokens > minTokens) {
      total += tokens;
    }
  }
  return total;
}

/**
 * Extracts and validates the tool call sequence from the end of a message array.
 * Tool sequences consist of: [assistant_with_tool_calls, tool_response_1, tool_response_2, ...]
 * or just a single user message.
 *
 * @param messages - Array of chat messages (will be modified by popping messages)
 * @returns Array of messages that form the tool sequence
 */
function extractToolSequence(messages: ChatMessage[]): ChatMessage[] {
  const lastMsg = messages.pop();
  if (!lastMsg) {
    throw new Error("Error parsing chat history: no user/tool message found");
  }

  const toolSequence: ChatMessage[] = [];

  if (lastMsg.role === "tool") {
    toolSequence.push(lastMsg);

    // Collect all consecutive tool messages from the end
    while (
      messages.length > 0 &&
      messages[messages.length - 1].role === "tool"
    ) {
      toolSequence.unshift(messages.pop()!);
    }

    // Get the assistant message with tool calls
    const assistantMsg = messages.pop();
    if (assistantMsg) {
      toolSequence.unshift(assistantMsg);

      // Validate that all tool messages have matching tool call IDs
      for (const toolMsg of toolSequence.slice(1)) {
        // Skip assistant message
        if (
          toolMsg.role === "tool" &&
          !messageHasToolCallId(assistantMsg, toolMsg.toolCallId)
        ) {
          throw new Error(
            `Error parsing chat history: no tool call found to match tool output for id "${toolMsg.toolCallId}"`,
          );
        }
      }
    }
  } else if (lastMsg.role === "assistant" || lastMsg.role === "thinking") {
    toolSequence.push(lastMsg);
    while (
      messages.length > 0 &&
      (messages[messages.length - 1].role === "thinking" ||
        messages[messages.length - 1].role === "assistant")
    ) {
      toolSequence.unshift(messages.pop()!);
    }
  } else {
    // Single user message
    toolSequence.push(lastMsg);
  }

  return toolSequence;
}

function pruneLinesFromTop(
  prompt: string,
  maxTokens: number,
  modelName: string,
): string {
  const lines = prompt.split("\n");
  // Preprocess tokens for all lines and cache them.
  const lineTokens = lines.map((line) => countTokens(line, modelName));
  let totalTokens = lineTokens.reduce((sum, tokens) => sum + tokens, 0);
  let start = 0;
  let currentLines = lines.length;

  // Calculate initial token count including newlines
  totalTokens += Math.max(0, currentLines - 1); // Add tokens for joining newlines

  // Using indexes instead of array modifications.
  // Remove lines from the top until the token count is within the limit.
  while (totalTokens > maxTokens && start < currentLines) {
    totalTokens -= lineTokens[start];
    // Decrement token count for the removed line and its preceding/joining newline (if not the last line)
    if (currentLines - start > 1) {
      totalTokens--;
    }
    start++;
  }

  return lines.slice(start).join("\n");
}

function pruneLinesFromBottom(
  prompt: string,
  maxTokens: number,
  modelName: string,
): string {
  const lines = prompt.split("\n");
  const lineTokens = lines.map((line) => countTokens(line, modelName));
  let totalTokens = lineTokens.reduce((sum, tokens) => sum + tokens, 0);
  let end = lines.length;

  // Calculate initial token count including newlines
  totalTokens += Math.max(0, end - 1); // Add tokens for joining newlines

  // Reverse traversal to avoid array modification
  // Remove lines from the bottom until the token count is within the limit.
  while (totalTokens > maxTokens && end > 0) {
    end--;
    totalTokens -= lineTokens[end];
    // Decrement token count for the removed line and its following/joining newline (if not the first line)
    if (end > 0) {
      totalTokens--;
    }
  }

  return lines.slice(0, end).join("\n");
}

function pruneStringFromBottom(
  modelName: string,
  maxTokens: number,
  prompt: string,
): string {
  const encoding = encodingForModel(modelName);

  const tokens = encoding.encode(prompt, "all", []);
  if (tokens.length <= maxTokens) {
    return prompt;
  }

  return encoding.decode(tokens.slice(0, maxTokens));
}

function pruneStringFromTop(
  modelName: string,
  maxTokens: number,
  prompt: string,
): string {
  const encoding = encodingForModel(modelName);

  const tokens = encoding.encode(prompt, "all", []);
  if (tokens.length <= maxTokens) {
    return prompt;
  }

  return encoding.decode(tokens.slice(tokens.length - maxTokens));
}

const MAX_TOKEN_SAFETY_BUFFER = 1000;
const TOKEN_SAFETY_PROPORTION = 0.02;
export function getTokenCountingBufferSafety(contextLength: number) {
  return Math.min(
    MAX_TOKEN_SAFETY_BUFFER,
    contextLength * TOKEN_SAFETY_PROPORTION,
  );
}

const MIN_RESPONSE_TOKENS = 1000;

function pruneRawPromptFromTop(
  modelName: string,
  contextLength: number,
  prompt: string,
  tokensForCompletion: number,
): string {
  const maxTokens =
    contextLength -
    tokensForCompletion -
    getTokenCountingBufferSafety(contextLength);
  return pruneStringFromTop(modelName, maxTokens, prompt);
}

/**
 * 方案.md §7.1.1/§7.1.2：**唯一的 token 预算计算**。`compileChatMessages`（发送路径的
 * prune 决策与指标）与 `measureChatMessagesNoPrune`（完整会话计量）必须共用这一处，
 * 禁止各自复制公式 —— 否则两边的 `availableTokens` / 安全缓冲 / 输出预留会漂移。
 */
export type ChatTokenBudget = {
  contextLength: number;
  countingSafetyBuffer: number;
  /** 为输出保留的 token：`min(MIN_RESPONSE_TOKENS, maxTokens)`。 */
  minOutputTokens: number;
  /** 供输入使用的预算：`contextLength − countingSafetyBuffer − minOutputTokens`。 */
  availableTokens: number;
};

export function resolveChatTokenBudget({
  knownContextLength,
  maxTokens,
}: {
  knownContextLength: number | undefined;
  maxTokens: number;
}): ChatTokenBudget {
  const contextLength = knownContextLength ?? DEFAULT_PRUNING_LENGTH;
  const countingSafetyBuffer = getTokenCountingBufferSafety(contextLength);
  const minOutputTokens = Math.min(MIN_RESPONSE_TOKENS, maxTokens);
  return {
    contextLength,
    countingSafetyBuffer,
    minOutputTokens,
    availableTokens: contextLength - countingSafetyBuffer - minOutputTokens,
  };
}

/**
 * 方案.md §7.1.1：**唯一的「一条消息算多少 token」口径**，含
 * `excludeToolOutputsFromTokenCount` 的「大 tool 输出算 0」规则。compile 与 measure 共用。
 *
 * 被排除的 tool 消息连 wrapper token（base/extra/toolCallId）一起算 0：相对于 tool 输出
 * 载荷可以忽略，而规则保持「一条大 tool 消息就是 0」这一简单形态。
 */
export function createBudgetMessageCounter({
  modelName,
  excludeToolOutputsFromTokenCount,
  excludeToolOutputsFromTokenCountMinTokens,
}: {
  modelName: string;
  excludeToolOutputsFromTokenCount?: boolean;
  excludeToolOutputsFromTokenCountMinTokens?: number;
}): {
  /** 单条 tool 消息被算 0 的门槛（默认 6000）。 */
  excludedToolOutputMinimum: number;
  countMessage(message: ChatMessage): number;
} {
  const excludedToolOutputMinimum =
    excludeToolOutputsFromTokenCountMinTokens ?? 6000;
  return {
    excludedToolOutputMinimum,
    countMessage: (message: ChatMessage): number => {
      const tokens = countChatMessageTokens(modelName, message);
      if (
        excludeToolOutputsFromTokenCount &&
        message.role === "tool" &&
        tokens > excludedToolOutputMinimum
      ) {
        return 0;
      }
      return tokens;
    },
  };
}

/**
 * 方案.md §7.1.1：compile 与 measure 共用的**消息分区**，步骤与顺序完全一致：
 *
 * ```text
 * 1. 浅拷贝输入（绝不修改调用方的数组/对象）
 * 2. 模型不支持图片时，把数组 content 渲染成字符串
 * 3. 取出 system message（第一条）
 * 4. 过滤 `chatMessageIsEmpty`，再 `addSpaceToAnyEmptyMessages`
 * 5. 从尾部抽出必须整体保留的序列（user 或 assistant+tool 组合）
 * ```
 *
 * `history` 是可按下标裁剪的历史（compile 的前缀裁剪对象）；`lastSequence` 是不可裁剪项。
 * 抽取失败时（例如过滤后一条不剩、或 tool 输出找不到对应 tool call）**不抛**：
 * 记下 `extractionError` 并让 `history` 保持原样，由 compile 决定是否原样抛出 ——
 * 计量路径按 §7.1.2 必须不抛。
 */
export type PreparedMessagesForBudget = {
  copies: ChatMessage[];
  systemMessage?: ChatMessage;
  lastSequence: ChatMessage[];
  history: ChatMessage[];
  lastSequenceExtracted: boolean;
  extractionError?: Error;
};

export function prepareMessagesForBudget(
  msgs: ChatMessage[],
  supportsImages: boolean,
): PreparedMessagesForBudget {
  const copies: ChatMessage[] = msgs.map((m) => ({ ...m }));

  if (!supportsImages) {
    for (const msg of copies) {
      if ("content" in msg && Array.isArray(msg.content)) {
        msg.content = renderChatMessage(msg);
      }
    }
  }

  const systemMessage = copies.find((msg) => msg.role === "system");
  // Explicitly widened: the filter's inferred type predicate excludes
  // SystemChatMessage, which `addSpaceToAnyEmptyMessages` returns as ChatMessage[].
  let remaining: ChatMessage[] = copies.filter((msg) => msg.role !== "system");
  remaining = remaining.filter((msg) => !chatMessageIsEmpty(msg));
  remaining = addSpaceToAnyEmptyMessages(remaining);
  const beforeExtraction = [...remaining];

  try {
    const lastSequence = extractToolSequence(remaining);
    return {
      copies,
      systemMessage,
      lastSequence,
      history: remaining,
      lastSequenceExtracted: true,
    };
  } catch (e) {
    return {
      copies,
      systemMessage,
      lastSequence: [],
      history: beforeExtraction,
      lastSequenceExtracted: false,
      extractionError: e as Error,
    };
  }
}

/**
 * 方案.md §7.1.3（C.3）：**影响计量的有效输入清单**，供后续（Stage 2D）生成
 * `constructionIdentity` 时纳入 —— Stage 2A 的身份只覆盖构造环境（model / mode /
 * reasoning / rules / tools / system / completion options / summary 语义），
 * `supportsImages` 与 exclude-tool-output 这一类**只影响 token 计数**的模型/全局配置
 * 当时不可见，必须在这里显式列出。
 *
 * 注意：`toolNames` 只用于可读性；tool 定义的完整形状（name/description/parameters）
 * 决定 `toolTokens`，而它已经作为 `effectiveTools` 进入 Stage 2A 的构造身份。
 */
export type MeasurementInputsAffectingTokens = {
  modelName: string;
  /** 解析后的窗口（`knownContextLength ?? DEFAULT_PRUNING_LENGTH`）。 */
  contextLength: number;
  maxTokens: number;
  /** 派生但影响预算，必须一起纳入身份。 */
  minOutputTokens: number;
  countingSafetyBuffer: number;
  supportsImages: boolean;
  toolNames: string[];
  excludeToolOutputsFromTokenCount: boolean;
  excludeToolOutputsFromTokenCountMinTokens: number;
};

export function measurementInputsAffectingTokens({
  modelName,
  knownContextLength,
  maxTokens,
  supportsImages,
  tools,
  excludeToolOutputsFromTokenCount,
  excludeToolOutputsFromTokenCountMinTokens,
}: {
  modelName: string;
  knownContextLength: number | undefined;
  maxTokens: number;
  supportsImages: boolean;
  tools?: Tool[];
  excludeToolOutputsFromTokenCount?: boolean;
  excludeToolOutputsFromTokenCountMinTokens?: number;
}): MeasurementInputsAffectingTokens {
  const budget = resolveChatTokenBudget({ knownContextLength, maxTokens });
  const { excludedToolOutputMinimum } = createBudgetMessageCounter({
    modelName,
    excludeToolOutputsFromTokenCount,
    excludeToolOutputsFromTokenCountMinTokens,
  });
  return {
    modelName,
    contextLength: budget.contextLength,
    maxTokens,
    minOutputTokens: budget.minOutputTokens,
    countingSafetyBuffer: budget.countingSafetyBuffer,
    supportsImages,
    toolNames: (tools ?? []).map((tool) => tool.function.name),
    excludeToolOutputsFromTokenCount: !!excludeToolOutputsFromTokenCount,
    excludeToolOutputsFromTokenCountMinTokens: excludedToolOutputMinimum,
  };
}

/**
 * Reconciles chat messages with available context length by intelligently pruning older messages
 * while preserving critical conversation elements.
 *
 * Core Guidelines:
 * - Always preserve the last user/tool message sequence (including any associated assistant message with tool calls)
 * - Always preserve the system message and tools
 * - Never allow orphaned tool responses without their corresponding tool calls
 * - Remove older messages first when pruning is necessary
 * - Maintain conversation coherence by flattening adjacent similar messages
 *
 * Process:
 * 1. Handle image content conversion for models that don't support images
 * 2. Extract and preserve system message
 * 3. Filter out empty messages and trailing non-user/tool messages
 * 4. Extract the complete tool sequence from the end (user message or assistant + tool responses)
 * 5. Calculate token requirements for non-negotiable elements (system, tools, last sequence)
 * 6. Prune older messages until within available token budget
 * 7. Reassemble with proper ordering and flatten adjacent similar messages
 *
 * @param params - Configuration object containing:
 *   - modelName: LLM model name for token counting
 *   - msgs: Array of chat messages to process
 *   - contextLength: Maximum context length supported by the model
 *   - maxTokens: Maximum tokens to reserve for the response
 *   - supportsImages: Whether the model supports image content
 *   - tools: Optional array of available tools
 * @returns Processed array of chat messages that fit within context constraints
 * @throws Error if non-negotiable elements exceed available context
 */
function compileChatMessages({
  modelName,
  msgs,
  knownContextLength,
  maxTokens,
  supportsImages,
  tools,
  excludeToolOutputsFromTokenCount,
  excludeToolOutputsFromTokenCountMinTokens,
  protectedMessageIndexes,
}: {
  modelName: string;
  msgs: ChatMessage[];
  knownContextLength: number | undefined;
  maxTokens: number;
  supportsImages: boolean;
  tools?: Tool[];
  /**
   * When true, `tool`-role message tokens are treated as free (0) for BOTH the
   * pruning budget and the reported `inputTokens` / `contextPercentage`. The
   * tool outputs are still reassembled and sent to the model unchanged — this
   * only defers pruning and lowers the displayed context usage, matching the
   * `_logEnd` accounting that also excludes tool outputs. Intended for models
   * whose real usable window exceeds the configured `contextLength` (or that
   * cache tool outputs), so large read_file/MCP results don't evict history.
   */
  excludeToolOutputsFromTokenCount?: boolean;
  /**
   * Minimum token count for a single `tool`-role message to be treated as free
   * (0) when `excludeToolOutputsFromTokenCount` is true. Tool outputs smaller
   * than this threshold are counted normally, so only large tool outputs (e.g.
   * big `read_file` results) are excluded. Defaults to 6000.
   */
  excludeToolOutputsFromTokenCountMinTokens?: number;
  /**
   * 方案.md §十四: indexes into the *input* `msgs` array that must never be
   * pruned (system, first turn and current turn for a Local Provider request,
   * which has no legitimate prunable middle history). If the budget cannot be
   * met without dropping one of them, this throws the "Not enough context"
   * error so the caller surfaces out-of-context instead of silently sending a
   * truncated conversation.
   */
  protectedMessageIndexes?: number[];
}): CompiledMessagesResult {
  let didPrune = false;

  // 方案.md §7.1.1: the counter, the message partition and the budget all come from
  // the shared helpers so `measureChatMessagesNoPrune` cannot drift from this path.
  const { countMessage: countMsgForBudget } = createBudgetMessageCounter({
    modelName,
    excludeToolOutputsFromTokenCount,
    excludeToolOutputsFromTokenCountMinTokens,
  });

  const prepared = prepareMessagesForBudget(msgs, supportsImages);
  const { copies: msgsCopy, systemMessage: systemMsg, history } = prepared;
  const toolSequence = prepared.lastSequence;
  if (!prepared.lastSequenceExtracted) {
    // Identical failure to the previous inline extraction, including the message.
    throw prepared.extractionError;
  }

  // Resolve the protected set against the copied objects before any filtering
  // mutates the array, so indexes always refer to the caller's input.
  const protectedMessages = new Set<ChatMessage>();
  if (protectedMessageIndexes?.length) {
    for (const index of protectedMessageIndexes) {
      const message = msgsCopy[index];
      if (message) {
        protectedMessages.add(message);
      }
    }
  }

  // Count tokens for all messages in the tool sequence. Tool outputs here are
  // part of the always-preserved last sequence, but when excluded they should
  // not inflate the budget/metrics either — matching `_logEnd` which subtracts
  // ALL tool-output tokens (not just history ones).
  let lastMessagesTokens = 0;
  for (const msg of toolSequence) {
    lastMessagesTokens += countMsgForBudget(msg);
  }

  // System message
  let systemMsgTokens = 0;
  if (systemMsg) {
    systemMsgTokens = countChatMessageTokens(modelName, systemMsg);
  }

  // Tools
  let toolTokens = 0;
  if (tools) {
    toolTokens = countToolsTokens(tools, modelName);
  }

  const {
    contextLength,
    countingSafetyBuffer,
    minOutputTokens,
    availableTokens,
  } = resolveChatTokenBudget({ knownContextLength, maxTokens });

  // Leave space for output/safety, then for the non-negotiable messages.
  let inputTokensAvailable =
    availableTokens - toolTokens - systemMsgTokens - lastMessagesTokens;

  // Make sure there's enough context for the non-excludable items
  if (knownContextLength !== undefined && inputTokensAvailable < 0) {
    throw new Error(
      `Not enough context available to include the system message, last user message, and tools.
        There must be at least ${minOutputTokens} tokens remaining for output.
        Request had the following token counts:
        - contextLength: ${knownContextLength}
        - counting safety buffer: ${countingSafetyBuffer}
        - tools: ~${toolTokens}
        - system message: ~${systemMsgTokens}
        - max output tokens: ${maxTokens}`,
    );
  }

  // Now remove messages till we're under the limit. Tool outputs count as 0
  // toward the budget when excluded, so large read_file/MCP results never
  // trigger eviction of older history (deferred pruning).
  let currentTotal = 0;
  const historyWithTokens = history.map((message) => {
    const tokens = countMsgForBudget(message);
    currentTotal += tokens;
    return {
      ...message,
      tokens,
      isProtected: protectedMessages.has(message),
    };
  });

  while (historyWithTokens.length > 0 && currentTotal > inputTokensAvailable) {
    // Pruning removes a prefix, so a protected message at the head means no
    // legal pruning is left: fail loudly instead of sending a partial prompt.
    if (historyWithTokens[0].isProtected) {
      throw new Error(
        `Not enough context available to include all protected messages ` +
          `(方案.md §十四). Request had the following token counts: ` +
          `- contextLength: ${knownContextLength} ` +
          `- max output: ${maxTokens} ` +
          `- system: ~${systemMsgTokens} ` +
          `- tools: ~${toolTokens} ` +
          `- protected history: ~${currentTotal}`,
      );
    }
    const message = historyWithTokens.shift()!;
    currentTotal -= message.tokens;
    didPrune = true;

    // At this point make sure no latent tool response without corresponding call
    while (historyWithTokens[0]?.role === "tool") {
      if (historyWithTokens[0].isProtected) {
        break;
      }
      const message = historyWithTokens.shift()!;
      currentTotal -= message.tokens;
    }
  }

  // Now reassemble
  const reassembled: ChatMessage[] = [];
  if (systemMsg) {
    reassembled.push(systemMsg);
  }
  reassembled.push(
    ...historyWithTokens.map(({ tokens, isProtected, ...rest }) => rest),
  );
  reassembled.push(...toolSequence);

  const inputTokens =
    currentTotal + systemMsgTokens + toolTokens + lastMessagesTokens;
  const contextPercentage = inputTokens / availableTokens;
  return {
    compiledChatMessages: reassembled,
    didPrune,
    contextPercentage,
    inputTokens,
    contextLength,
  };
}

/**
 * 方案.md §7.1.2：**完整逻辑会话的 no-prune 计量**。
 *
 * 与 `compileChatMessages` 共用同一套预算、计数口径与消息分区（`resolveChatTokenBudget` /
 * `createBudgetMessageCounter` / `prepareMessagesForBudget`），但：
 *
 * ```text
 * 不裁剪消息
 * 不生成 compiledChatMessages
 * 不抛 "Not enough context"（空 history / tool 序列不匹配都只是照实计量）
 * 允许 contextPercentage > 1
 * 不修改入参
 * ```
 *
 * `protectedMessageIndexes` 不属于计量输入：它只影响发送路径「宁可报错也不发半截提示词」的
 * 决策，计量必须覆盖完整会话。
 *
 * `availableTokens` 是**输入可用预算**（`contextLength − 安全缓冲 − 输出预留`），
 * `exceedsContext = inputTokens > availableTokens` —— 这与 §7.1.1 的最终语义一致，
 * 与 Stage 2A 过渡期「窗口剩余量」的临时写法不同。
 */
export type ChatTokenMeasurement = {
  inputTokens: number;
  contextLength: number;
  availableTokens: number;
  contextPercentage: number;
  exceedsContext: boolean;
};

function measureChatMessagesNoPrune({
  modelName,
  msgs,
  knownContextLength,
  maxTokens,
  supportsImages,
  tools,
  excludeToolOutputsFromTokenCount,
  excludeToolOutputsFromTokenCountMinTokens,
}: {
  modelName: string;
  msgs: ChatMessage[];
  knownContextLength: number | undefined;
  maxTokens: number;
  supportsImages: boolean;
  tools?: Tool[];
  excludeToolOutputsFromTokenCount?: boolean;
  excludeToolOutputsFromTokenCountMinTokens?: number;
}): ChatTokenMeasurement {
  const { countMessage } = createBudgetMessageCounter({
    modelName,
    excludeToolOutputsFromTokenCount,
    excludeToolOutputsFromTokenCountMinTokens,
  });
  const prepared = prepareMessagesForBudget(msgs, supportsImages);
  const { availableTokens, contextLength } = resolveChatTokenBudget({
    knownContextLength,
    maxTokens,
  });

  const systemMsgTokens = prepared.systemMessage
    ? countChatMessageTokens(modelName, prepared.systemMessage)
    : 0;
  const toolTokens = tools ? countToolsTokens(tools, modelName) : 0;

  let messagesTokens = 0;
  for (const message of prepared.history) {
    messagesTokens += countMessage(message);
  }
  for (const message of prepared.lastSequence) {
    messagesTokens += countMessage(message);
  }

  const inputTokens = systemMsgTokens + toolTokens + messagesTokens;
  return {
    inputTokens,
    contextLength,
    availableTokens,
    // 预算非正只可能来自「输出预留 ≥ 窗口」这类配置异常；此时仍要给出超限信号，
    // 而不是 NaN。`exceedsContext` 才是权威判断。
    contextPercentage:
      availableTokens > 0
        ? inputTokens / availableTokens
        : inputTokens > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    exceedsContext: inputTokens > availableTokens,
  };
}

async function cleanupAsyncEncoders(): Promise<void> {
  try {
    await llamaAsyncEncoder.close();
  } catch (e) {}
}

export {
  cleanupAsyncEncoders,
  compileChatMessages,
  countTokens,
  countTokensAsync,
  extractToolSequence,
  measureChatMessagesNoPrune,
  pruneLinesFromBottom,
  pruneLinesFromTop,
  pruneRawPromptFromTop,
  pruneStringFromBottom,
  pruneStringFromTop,
};
