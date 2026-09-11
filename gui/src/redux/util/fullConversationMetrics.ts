import type { MessageModes, RuleWithSource, Tool } from "core";
import type { RulePolicies } from "core/llm/rules/types";

/**
 * 方案.md §五.16.5/§五.16.6：GUI runtime 的**完整逻辑会话**指标。
 *
 * 这个模块只保留 **GUI 侧的过渡适配**：「发送载荷 compile 结果 → 快照」与
 * 「legacy 磁盘字段 / 完整 Result ↔ 快照」。契约本体（类型、版本号、唯一 identity helper）
 * 与 `history/save` 的计量共用同一份，定义在 `core/util/fullConversationMetrics.ts`
 * 并从那里 re-export（GUI 只做转发，不复制）。这里不依赖 Redux / React，也不读 store。
 *
 * 过渡期边界（Stage 2D 起）：
 * - `history/save` 携带计量时，磁盘 `Session.contextMetrics` 已是完整
 *   `FullConversationMetricsResult`；未携带时仍是 legacy `didPrune` 形状（旧数据亦然）。
 *   因此读取侧必须在**同一次归一化**里区分两种形状：Result ⇒ 恢复数值 + 身份，
 *   legacy ⇒ 只恢复数值（无身份即 stale）。完整的 fresh/stale/unavailable 分类属 Stage 2E。
 */

// 共享契约（类型 + 版本常量 + 唯一 identity helper）住在 Core
// （`core/util/fullConversationMetrics.ts`）：`history/save` 的锁内计量与 GUI 用同一份，
// **不两边各复制一份**，也不在这里 re-export 出第二个入口 —— 需要的地方直接从 Core import。
import type {
  FullConversationMetricsMeta,
  FullConversationMetricsResult,
  FullConversationMetricsSnapshot,
} from "core/util/fullConversationMetrics";

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
 * 过渡读取：磁盘 `Session.contextMetrics` → runtime 数值 + 身份。
 *
 * 两种形状必须在**同一处**区分（Stage 2D 起 `history/save` 会写完整 Result）：
 * - `FullConversationMetricsResult`（`metrics` + `meta` 都在）⇒ 数值与身份一起恢复；
 *   freshness 由门禁按 revision / constructionIdentity / schema 比较决定，
 *   因此这里**不**替调用方判定；
 * - legacy `didPrune` 形状 ⇒ 只恢复数值，没有身份 ⇒ stale（§五.16.5），首次门禁检查会重算。
 *
 * 完整的 `normalizePersistedContextMetrics`（含 `unavailable`）属 Stage 2E。
 */
export function persistedContextMetricsToRuntime(
  value: LegacyDiskContextMetrics | FullConversationMetricsResult | undefined,
): {
  metrics?: FullConversationMetricsSnapshot;
  meta?: FullConversationMetricsMeta;
} {
  if (!value) {
    return {};
  }
  if ("metrics" in value && value.metrics && "meta" in value && !!value.meta) {
    return { metrics: value.metrics, meta: value.meta };
  }
  return {
    metrics: fullConversationMetricsFromCompileResult(
      value as LegacyDiskContextMetrics,
    ),
  };
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
