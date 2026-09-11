import type {
  LLMFullCompletionOptions,
  MessageModes,
  RuleWithSource,
  Tool,
} from "..";
import type { RulePolicies } from "../llm/rules/types";

/**
 * 方案.md §五.16.5/§五.16.7：**完整逻辑会话指标**的共享契约。
 *
 * 这里放 Core 与 GUI 共用的类型与唯一纯 helper（不依赖 Redux / React / active session）。
 * Stage 2D 之前它们只存在于 GUI（`gui/src/redux/util/fullConversationMetrics.ts`）；
 * `history/save` 的计量与 `history/measureConversation` 也需要同一批类型，因此下沉到 Core，
 * **不允许两边各复制一份**。
 *
 * GUI 侧仍保留的只有过渡适配（compileChat 结果 / legacy 磁盘字段 ↔ 快照）。
 */

/** 快照形状或其语义变化时递增（方案.md §五.16.6）。 */
export const FULL_CONVERSATION_METRICS_SCHEMA_VERSION = 1;

/**
 * summary 构造语义版本（方案.md §五.16.2）：summary 的**构造算法/语义**变化时递增。
 * 它属于 constructionIdentity —— summary 的**内容**变化才是内容版本。
 */
export const CONVERSATION_SUMMARY_SEMANTICS_VERSION = 1;

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
  /**
   * 只影响 **token 计数**、不影响消息内容的输入（方案.md §7.1.3 C.3 的
   * `measurementInputsAffectingTokens`）：图片能力、tool-output 排除规则、
   * 解析后的窗口、输出预留与计数安全缓冲。
   *
   * 这些值 GUI 看不到"消息层面"的差异，却是同一份会话显示不同占用的原因；
   * 不纳入身份就会出现「开关变了、数字没变」的陈旧快照。
   */
  measurementInputs: {
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
  conversationSummarySemanticsVersion: number;
};

/**
 * 方案.md §五.16.7：携带计量输入的 `history/save` 请求。
 *
 * 由 GUI 组装（构造输入 + 计量身份），Core 在保存锁内用**同一份 finalHistory**
 * 构造并计量。`modelTitle` 用于 Core 按标题解析模型（不回退全局选择），
 * 由此得到 tokenizer、窗口、图片能力与 tool-output 排除规则 —— 也就是
 * `measurementInputsAffectingTokens` 里那些 GUI 看不到的输入。
 *
 * 缺省整个字段 = 只保存、不计量的正常路径（Core 不得因此清空磁盘 metrics）。
 */
export type FullConversationMeasurementRequest = {
  modelTitle: string;
  mode: MessageModes;
  /** 已经渲染好的 system message（base + 生效规则 + system-tools 框架）。 */
  systemMessage: string;
  rules: RuleWithSource[];
  ruleSettings: RulePolicies;
  tools: Tool[];
  /** 会话的 reasoning 偏好；`undefined` = 由模型决定。 */
  reasoning?: boolean;
  completionOptions: LLMFullCompletionOptions;
  conversationSummaryOverride?: string;
  conversationRevision: number;
  constructionIdentity: string;
  schemaVersion: number;
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
 * 不同的构造环境即可实测碰撞（见 GUI 侧测试与 Stage 2A 记录）。canonical 形式保证：
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

/**
 * 方案.md §7.1.4：快照必须**有限且 JSON-safe**。
 *
 * 这份快照会经 `history/save` 持久化到 `Session.contextMetrics`，而 JSON 没有非有限数：
 * `JSON.stringify` 把 `Infinity` / `NaN` 写成 `null`，读回时 §五.16.5 的归一化只看到 `null`
 * 且**不得**猜回原始值，于是「刚写下的 Result 一 reload 就 `unavailable`」。
 *
 * 生产侧的真实修法是让计量本身只产出有限值（`countTokens.ts` 的
 * `OVER_BUDGET_CONTEXT_PERCENTAGE`）；这个谓词是**写入边界的兜底**：与其把一个自己就知道
 * 读方必须拒绝的值写进磁盘，不如保留磁盘上已有的 metrics（并大声 warn），让下一次计量收敛。
 * 它不改变 history 的完整性 —— 计量失败从来不影响保存会话内容。
 */
export function isJsonSafeMetricsSnapshot(
  metrics: FullConversationMetricsSnapshot,
): boolean {
  return (
    Number.isFinite(metrics.inputTokens) &&
    Number.isFinite(metrics.contextLength) &&
    Number.isFinite(metrics.availableTokens) &&
    Number.isFinite(metrics.contextPercentage) &&
    typeof metrics.exceedsContext === "boolean"
  );
}
