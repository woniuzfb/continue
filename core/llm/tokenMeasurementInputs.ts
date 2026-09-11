import type { Tool } from "../index.js";
import { DEFAULT_PRUNING_LENGTH } from "./constants.js";

/**
 * 方案.md §7.1.1/§7.1.2：**token 预算与「影响计量的输入」的纯投影**。
 *
 * 这个模块的存在理由是模块图，不是分层美观：`countTokens.ts` 是 **Node/Core-only** 的
 * ——它导入 `./asyncEncoder.js`（`workerpool` → `worker_threads` / `os` / `child_process` /
 * `path`）、`./llamaTokenizer.js` 与 `js-tiktoken`。GUI（webview）只需要「同一份预算公式」
 * 与「同一份 identity 投影」，一旦从 `countTokens.ts` 导入，Vite 就会把整条 Node 依赖链
 * 打进浏览器 bundle 并把那些模块 externalize 成空壳，webview 启动可能直接白屏。
 *
 * 因此凡是**浏览器侧也要用**的纯计算都放在这里，且本文件**不得**引入 tokenizer、
 * worker、`fs` / `path` / `process` 等任何 Node 能力 —— 只能导入纯常量与类型。
 *
 * ```text
 * browser-safe（本文件）   getTokenCountingBufferSafety / resolveChatTokenBudget
 *                          resolveExcludedToolOutputMinimum / measurementInputsAffectingTokens
 * Node/Core-only           countTokens.ts（计数、裁剪、compile、no-prune 计量）
 * ```
 */

const MAX_TOKEN_SAFETY_BUFFER = 1000;
const TOKEN_SAFETY_PROPORTION = 0.02;

/** 为计数误差预留的安全缓冲：`min(1000, contextLength × 2%)`。 */
export function getTokenCountingBufferSafety(contextLength: number) {
  return Math.min(
    MAX_TOKEN_SAFETY_BUFFER,
    contextLength * TOKEN_SAFETY_PROPORTION,
  );
}

const MIN_RESPONSE_TOKENS = 1000;

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

/** 单条 `tool` 消息被算 0 的默认门槛（`excludeToolOutputsFromTokenCount`）。 */
export const DEFAULT_EXCLUDED_TOOL_OUTPUT_MIN_TOKENS = 6000;

/**
 * 排除阈值只有一个默认值（6000），这里从**纯常量**解析。
 *
 * 刻意不复用 `createBudgetMessageCounter()`：那个工厂的闭包会引用
 * `countChatMessageTokens`（真 tokenizer），把它拉进来就等于把 Node 依赖链重新带进
 * 浏览器可用的模块 —— 一个默认值不值得。
 */
export function resolveExcludedToolOutputMinimum(
  value: number | undefined,
): number {
  return value ?? DEFAULT_EXCLUDED_TOOL_OUTPUT_MIN_TOKENS;
}

/**
 * 方案.md §7.1.3（C.3）：**只影响 token 计数、不影响消息内容**的模型/工具/配置输入的
 * 显式投影。GUI 用它算 `constructionIdentity` 的 `measurementInputs`（Core 侧计量与本
 * 投影必须同源，否则会出现「公式变了、快照还 fresh」）。
 *
 * 纯函数：不做 IO、不读全局状态、不碰 tokenizer。
 */
export type MeasurementInputsAffectingTokens = {
  modelName: string;
  contextLength: number;
  maxTokens: number;
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
  return {
    modelName,
    contextLength: budget.contextLength,
    maxTokens,
    minOutputTokens: budget.minOutputTokens,
    countingSafetyBuffer: budget.countingSafetyBuffer,
    supportsImages,
    toolNames: (tools ?? []).map((tool) => tool.function.name),
    excludeToolOutputsFromTokenCount: !!excludeToolOutputsFromTokenCount,
    excludeToolOutputsFromTokenCountMinTokens: resolveExcludedToolOutputMinimum(
      excludeToolOutputsFromTokenCountMinTokens,
    ),
  };
}
