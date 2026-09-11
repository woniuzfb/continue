import type { MessageModes, RuleWithSource, Tool } from "core";
import type { RulePolicies } from "core/llm/rules/types";

/**
 * 方案.md §五.16.5/§五.16.6：GUI runtime 的**完整逻辑会话**指标。
 *
 * 这个模块只放三样东西：状态契约（类型与版本号）、唯一的构造身份纯 helper、
 * 以及与「发送载荷 compile 结果 / legacy 磁盘字段」之间的过渡适配。它不依赖
 * Redux / React / active session，也不读 store。
 *
 * 过渡期边界（Stage 2A，见 §五.16.5 与已知限制）：
 * - 生产这五个数值的仍是 `llm/compileChat`，不是 Core 的 no-prune 计量（Stage 2C）；
 * - 磁盘 `Session.contextMetrics` 仍是 legacy `didPrune` 形状（Core 原子计量与
 *   Result 持久化属 Stage 2D），所以这里提供两个显式适配函数而不是直接复用字段。
 */

/** 快照形状或其语义变化时递增（方案.md §五.16.6）。 */
export const FULL_CONVERSATION_METRICS_SCHEMA_VERSION = 1;

/**
 * summary 构造语义版本（方案.md §五.16.2）：summary 的**构造算法/语义**变化时递增。
 * 它属于 constructionIdentity —— summary 的**内容**变化才是内容版本。
 */
export const CONVERSATION_SUMMARY_SEMANTICS_VERSION = 1;

/**
 * 一旦带入 constructionIdentity 输入，这些字段就不允许再单独进入版本比较
 * （方案 §五.16.2：identity 统一覆盖 model / mode / reasoning / rules / tools /
 * system / completion options / summary 语义；比较不匹配即重算）。
 */
export type FullConversationMetricsSnapshot = {
  inputTokens: number;
  contextLength: number;
  availableTokens: number;
  contextPercentage: number;
  exceedsContext: boolean;
};

export type FullConversationMetricsMeta = {
  conversationRevision: number;
  constructionIdentity: string;
  schemaVersion: number;
};

export type FullConversationMetricsResult = {
  metrics: FullConversationMetricsSnapshot;
  meta: FullConversationMetricsMeta;
};

/**
 * constructionIdentity 的输入（方案.md §五.16.2）。**全部显式传入**，
 * helper 只做稳定序列化，不读 store，也不看 active session。
 */
export type FullConversationConstructionInputs = {
  /** session 自己的聊天模型身份（title）；由此解析模型配置与 tokenizer。 */
  modelIdentity: string;
  mode: MessageModes;
  reasoningEnabled: boolean | undefined;
  /** 参与构造的规则（含内容）；禁用与否由 ruleSettings 表达。 */
  effectiveRules: readonly RuleWithSource[];
  ruleSettings: RulePolicies;
  effectiveTools: readonly Tool[];
  /** 已经渲染好的 system message 输入（base system + 规则 + system-tools 框架）。 */
  systemMessageInputs: string;
  completionOptionsInputsAffectingMeasurement: {
    /** `completionOptions.model`：tokenizer / 计量的键。 */
    model: string;
    maxTokens?: number;
    /** 影响可用预算的模型上下文长度（若选项里显式给出）。 */
    contextLength?: number;
  };
  conversationSummarySemanticsVersion: number;
};

/**
 * 稳定序列化：对象键排序后再 `JSON.stringify`，因此同样的输入永远得到同样的字符串
 * （JS 对象键顺序、`undefined` 字段的书写顺序都不影响结果）。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/**
 * constructionIdentity 的**唯一实现**（方案.md §五.16.2）。
 *
 * 身份**就是**输入的 canonical 序列化本身，不是摘要：身份参与的是
 * 「异步结果是否仍属于当前构造环境」的**正确性门禁**（门禁不匹配 ⇒ 丢弃结果、
 * 判定快照陈旧），因此这里不能接受任何有限的哈希空间 —— 32 位摘要用 150k 个
 * 不同的构造环境即可实测碰撞（见 `fullConversationMetrics.test.ts` 的探针与
 * Stage 2A 记录）。canonical 形式保证：
 *
 * - 相同输入 ⇒ 严格相同的字符串；
 * - **对 `FullConversationConstructionInputs` 所允许的规范化 JSON 输入域，任一未被明确忽略的
 *   输入值变化都会改变 identity**（只有 `undefined` 字段被忽略，无碰撞可能）。这个承诺只覆盖
 *   该封闭输入域：不要让 Date、`NaN`/`Infinity`/`-0`、循环引用或其它非 JSON 值进入 identity ——
 *   canonical 序列化对它们不成立；
 * - 数组顺序有意义并保留（tools / rules 的顺序属于构造输入）。
 *
 * 若将来为了缩短磁盘或协议表示要改摘要，必须用**跨宿主一致的强摘要**
 * （如 SHA-256），且 canonical 输入仍是唯一权威 —— 不得退回自造短哈希。
 */
export function fullConversationConstructionIdentity(
  inputs: FullConversationConstructionInputs,
): string {
  return canonicalJson(inputs);
}

/** 发送路径 `llm/compileChat` 结果的形状（过渡期唯一的数值来源）。 */
export type CompileChatMetricsResult = {
  didPrune: boolean;
  contextPercentage: number;
  inputTokens?: number;
  contextLength?: number;
};

/**
 * 过渡适配（方案.md §五.16.5 / Stage 2C 待替换）：把 `llm/compileChat` 的结果
 * 映射成完整会话快照。
 *
 * 两处刻意的过渡语义，Stage 2C 的 Core no-prune 计量会替换它们：
 * - `availableTokens` 这里是**窗口剩余**（`contextLength - inputTokens`），
 *   不是 2C 定义的「扣除输出预留与安全缓冲后的可用预算」；
 * - `exceedsContext` 用 `didPrune`：compile 需要裁剪就说明完整会话放不下
 *   （Local Provider 保护全部消息时直接抛错、不产生快照，因此没有第二个信号）。
 */
export function fullConversationMetricsFromCompileResult(
  result: CompileChatMetricsResult,
): FullConversationMetricsSnapshot {
  const contextLength = result.contextLength ?? 0;
  const inputTokens = result.inputTokens ?? 0;
  return {
    inputTokens,
    contextLength,
    availableTokens: Math.max(0, contextLength - inputTokens),
    contextPercentage: result.contextPercentage,
    exceedsContext: result.didPrune,
  };
}

/** legacy 磁盘字段形状（`Session.contextMetrics`，Stage 2D 才会变成完整 Result）。 */
export type LegacyDiskContextMetrics = {
  didPrune: boolean;
  contextPercentage: number;
  inputTokens?: number;
  contextLength?: number;
};

/**
 * 过渡读取：磁盘快照 → runtime 数值。**不产生 identity**：legacy 形状没有构造身份，
 * 因此调用方恢复后一律视为 stale（§五.16.5：只有 snapshot、没有 meta ⇒ stale），
 * 首次门禁检查会重算。完整的 `normalizePersistedContextMetrics`（fresh/stale/unavailable
 * 判定与旧形状归一）属 Stage 2E。
 */
export function fullConversationMetricsFromLegacyDisk(
  legacy: LegacyDiskContextMetrics | undefined,
): FullConversationMetricsSnapshot | undefined {
  return legacy ? fullConversationMetricsFromCompileResult(legacy) : undefined;
}

/**
 * 过渡写入：runtime 数值 → 磁盘 legacy 字段（保存载荷）。方向与上面相反，
 * 因此磁盘上的字段名与形状在 Stage 2A 保持不变（Core 侧零改动）。
 */
export function legacyDiskContextMetricsFromFullConversation(
  metrics: FullConversationMetricsSnapshot | undefined,
): LegacyDiskContextMetrics | undefined {
  return metrics
    ? {
        didPrune: metrics.exceedsContext,
        contextPercentage: metrics.contextPercentage,
        inputTokens: metrics.inputTokens,
        contextLength: metrics.contextLength,
      }
    : undefined;
}
