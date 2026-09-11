import type { LegacyContextMetricsSnapshot, MessageModes } from "core";
import type {
  FullConversationMetricsMeta,
  FullConversationMetricsResult,
  FullConversationMetricsSnapshot,
} from "core/util/fullConversationMetrics";

/**
 * 方案.md §五.16.5/§五.16.6：GUI runtime 的**完整逻辑会话**指标与磁盘兼容读取。
 *
 * 契约本体（类型、版本号、唯一 identity helper）与 `history/save` 的计量共用同一份，
 * 定义在 `core/util/fullConversationMetrics.ts`，GUI 直接从 Core import（不 re-export
 * 第二个入口、不复制）。这个模块只拥有**GUI 侧**的两件事：
 *
 * 1. 磁盘 `Session.contextMetrics` 的**归一化**（`normalizePersistedContextMetrics`）：
 *    磁盘上可能是 Stage 2D 起写入的完整 `FullConversationMetricsResult`，也可能是历史
 *    legacy `didPrune` 形状，读取侧必须在同一处区分；
 * 2. freshness 分类（`FullConversationMetricsFreshness`）：它比较的是「快照身份 vs
 *    **当前**构造环境」，因此只能属于持有当前 state 的一侧，不属于 Core 契约。
 */

/**
 * 快照相对**当前构造环境**的可信度（方案.md §五.16.6）。四态都是给消费者看的陈述，
 * 不是决策：
 *
 * - `fresh`：三项身份（conversationRevision + constructionIdentity + schemaVersion）
 *   都能对上当前环境 —— **只有它**可以被自动决策（例如自动压缩阈值）当作权威；
 * - `stale`：数值是 last-known，仍可显示，但身份对不上（内容/构造环境已经变了，
 *   或磁盘只有数值没有身份）；
 * - `measuring`：该 session 的只读计量正在飞行中 —— 数值还没到，不是「旧值」；
 * - `unavailable`：连可用的数值都没有（没有快照、或磁盘形状无法可靠转换）。
 */
export type FullConversationMetricsFreshness =
  | "fresh"
  | "stale"
  | "measuring"
  | "unavailable";

/**
 * 归一化的输入（方案.md §五.16.5 的签名）：磁盘 `Session.contextMetrics` 的两种形状
 * （见 core/index.d.ts），外加**裸 snapshot** —— 它不是 Core 会写的东西，但接收侧要对
 * 「只有数值、没有身份」保持宽容（迁移期数据、测试夹具、旧版本残留）。
 */
export type PersistedContextMetricsValue =
  | LegacyContextMetricsSnapshot
  | FullConversationMetricsSnapshot
  | FullConversationMetricsResult;

/** 归一化结果：能恢复的数值 / 身份 + 可信度。字段缺失是信息，不是错误。 */
export type NormalizedPersistedContextMetrics = {
  metrics?: FullConversationMetricsSnapshot;
  meta?: FullConversationMetricsMeta;
  freshness: FullConversationMetricsFreshness;
};

const UNAVAILABLE: NormalizedPersistedContextMetrics = {
  freshness: "unavailable",
};

/**
 * 快照被接受时的**构造环境指纹**（方案.md §五.16.6）。
 *
 * 为什么不是「每帧重算 canonical identity」：`constructionIdentity` 的输入包含**渲染后的
 * system message**（base system + 生效规则 + system-tools 框架）与全部工具定义，重算一次
 * 要重跑规则渲染；而 ContextStatus / ResponseActions 在流式输出期间每个 chunk 都会重新
 * 选择一遍 state。因此 fresh 判定必须是 O(1) 的**已存状态**比较。
 *
 * 指纹取得的是构造环境的**输入引用**（Redux 不可变更新 ⇒ 引用变即输入可能变，反之输入
 * 逐字相同则引用相同）：
 *
 * ```text
 * config.rules / config.tools / experimental / skipBaseSystemMessage
 * config.modelsByRole[chat] / config.selectedModelByRole[chat]
 * ui.toolSettings / ui.toolGroupSettings / ui.ruleSettings
 * session.chatModelTitle / mode / hasReasoningEnabled
 * ```
 *
 * 保守方向：引用变了但逐字内容没变 ⇒ 判 stale（少报 fresh，不会多报）。**不多报**是这里
 * 唯一重要的性质：`stale` 只影响消费者是否把它当权威，不影响显示。
 */
export type FullConversationMetricsEnvironment = {
  rules: unknown;
  tools: unknown;
  experimental: unknown;
  skipBaseSystemMessage: boolean;
  modelsByRole: unknown;
  selectedModelByRole: unknown;
  toolSettings: unknown;
  toolGroupSettings: unknown;
  ruleSettings: unknown;
  chatModelTitle: string | undefined;
  mode: MessageModes;
  hasReasoningEnabled: boolean | undefined;
};

/**
 * 两个环境指纹是否描述同一个构造环境（方案.md §五.16.6）。全部字段都必须是同一引用
 * （标量按值）—— 这是**保守**判定：任一字段换了引用就返回 false，宁可少报 fresh。
 * 快照没有指纹（磁盘恢复、或旧版本留下）时返回 false ⇒ stale。
 */
export function sameFullConversationMetricsEnvironment(
  a: FullConversationMetricsEnvironment | undefined,
  b: FullConversationMetricsEnvironment | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return (
    a.rules === b.rules &&
    a.tools === b.tools &&
    a.experimental === b.experimental &&
    a.skipBaseSystemMessage === b.skipBaseSystemMessage &&
    a.modelsByRole === b.modelsByRole &&
    a.selectedModelByRole === b.selectedModelByRole &&
    a.toolSettings === b.toolSettings &&
    a.toolGroupSettings === b.toolGroupSettings &&
    a.ruleSettings === b.ruleSettings &&
    a.chatModelTitle === b.chatModelTitle &&
    a.mode === b.mode &&
    a.hasReasoningEnabled === b.hasReasoningEnabled
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 一个完整逻辑会话快照：五个字段齐全且类型正确（缺一个都不算快照）。 */
function isFullConversationSnapshot(
  value: unknown,
): value is FullConversationMetricsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return (
    isFiniteNumber(snapshot.inputTokens) &&
    isFiniteNumber(snapshot.contextLength) &&
    isFiniteNumber(snapshot.availableTokens) &&
    isFiniteNumber(snapshot.contextPercentage) &&
    typeof snapshot.exceedsContext === "boolean"
  );
}

function isCompleteMeta(value: unknown): value is FullConversationMetricsMeta {
  if (!value || typeof value !== "object") {
    return false;
  }
  const meta = value as Record<string, unknown>;
  return (
    isFiniteNumber(meta.conversationRevision) &&
    typeof meta.constructionIdentity === "string" &&
    isFiniteNumber(meta.schemaVersion)
  );
}

function isLegacyDiskSnapshot(
  value: unknown,
): value is LegacyContextMetricsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const legacy = value as Record<string, unknown>;
  return (
    typeof legacy.didPrune === "boolean" &&
    isFiniteNumber(legacy.contextPercentage) &&
    (legacy.inputTokens === undefined || isFiniteNumber(legacy.inputTokens)) &&
    (legacy.contextLength === undefined || isFiniteNumber(legacy.contextLength))
  );
}

/**
 * legacy `didPrune` 形状 → 完整快照（方案.md §五.16.5）。
 *
 * legacy 磁盘形状没有可用预算，也没有「是否超限」的真实语义，只能按当时发送路径的口径
 * 反推：`availableTokens` 取窗口剩余（`contextLength - inputTokens`），`exceedsContext`
 * 取 `didPrune`。这个反推**不保证**与 §五.16.5 的预算定义一致 —— 因此调用方拿到的是
 * `stale`（身份缺失），下一次带 measurement 的保存会把磁盘升级成完整 Result。
 */
function legacySnapshotToFull(
  legacy: LegacyContextMetricsSnapshot,
): FullConversationMetricsSnapshot {
  const contextLength = legacy.contextLength ?? 0;
  const inputTokens = legacy.inputTokens ?? 0;
  return {
    inputTokens,
    contextLength,
    availableTokens: Math.max(0, contextLength - inputTokens),
    contextPercentage: legacy.contextPercentage,
    exceedsContext: legacy.didPrune,
  };
}

/**
 * 归一化磁盘 `contextMetrics`（方案.md §五.16.5）。
 *
 * ```text
 * 完整 Result（metrics + 完整 meta）  ⇒ 数值 + 身份，freshness = "fresh"
 *                                      ——「可比较」；是否真的匹配**当前**环境
 *                                      由调用方与当前 identity/revision/schema 比较后降级
 * 裸 snapshot（只有 numbers）        ⇒ 数值，freshness = "stale"（磁盘上没有身份）
 * legacy didPrune shape              ⇒ 反推数值，freshness = "stale"
 * 缺失 / 形状无法可靠转换            ⇒ freshness = "unavailable"
 * ```
 *
 * 返回 `fresh` **不等于**可以当权威使用：它只表示磁盘上带着一份完整、可比较的身份。
 * 真正的 `fresh` 判定在 selector 里（要拿当前构造环境去比），而且磁盘恢复的会话在
 * `conversationRevision` 从 0 重新开始的情况下必然被重算一次。
 */
export function normalizePersistedContextMetrics(
  value: PersistedContextMetricsValue | undefined,
): NormalizedPersistedContextMetrics {
  if (!value) {
    return UNAVAILABLE;
  }
  if ("metrics" in value) {
    const metrics = (value as FullConversationMetricsResult).metrics;
    const meta = (value as FullConversationMetricsResult).meta;
    if (!isFullConversationSnapshot(metrics)) {
      // 号称是 Result，但数值本身不完整：不能拿半个快照去显示。
      return UNAVAILABLE;
    }
    return isCompleteMeta(meta)
      ? { metrics, meta, freshness: "fresh" }
      : // 有数值没身份：可显示，但身份缺失 ⇒ stale。
        { metrics, freshness: "stale" };
  }
  if (isFullConversationSnapshot(value)) {
    return { metrics: value, freshness: "stale" };
  }
  if (isLegacyDiskSnapshot(value)) {
    return { metrics: legacySnapshotToFull(value), freshness: "stale" };
  }
  return UNAVAILABLE;
}
