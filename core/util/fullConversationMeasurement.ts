import type {
  ChatHistoryItem,
  ChatMessage,
  LLMFullCompletionOptions,
} from "..";
import type { ChatTokenMeasurement } from "../llm/countTokens";
import { SystemMessageToolCodeblocksFramework } from "../tools/systemMessageTools/toolCodeblocks";
import { constructMessages } from "./constructMessages";
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  type FullConversationMeasurementRequest,
  type FullConversationMetricsResult,
} from "./fullConversationMetrics";

/**
 * 方案.md §五.16.4/§五.16.7：**保存锁内的完整会话计量**。
 *
 * Core 在这里用与发送路径**同一个**共享纯构造核心（`core/util/constructMessages.ts`）构造
 * 请求消息，再用与 `compileChatMessages` **同一套**预算/计数口径做 no-prune 计量
 * （`measure` 回调即 `BaseLLM.measureChatMessagesNoPrune`）。因此：
 *
 * - 构造语义与 GUI 发送路径一致（Stage 2B 起唯一实现）；
 * - token 口径与发送路径一致（Stage 2C 起共享 helper）；
 * - 结果是「写盘后的语义内容」的指标 —— 与 reload 后运行时读到的内容同源。
 *
 * `measure` 由调用方注入（Core 的 `history/save` handler 用按标题解析出的模型构造），
 * 这样本模块不依赖 LLM 类，也不读 active model。
 */
export function measureFullConversationForSave({
  history,
  request,
  measure,
}: {
  history: ChatHistoryItem[];
  request: FullConversationMeasurementRequest;
  measure: (
    messages: ChatMessage[],
    options: LLMFullCompletionOptions,
  ) => ChatTokenMeasurement;
}): FullConversationMetricsResult {
  // system-tools 框架与发送路径同源：GUI 只在 **未使用 native tools** 时创建框架，
  // 而 `buildSessionCompletionOptions` 只在 native tools 生效时才把 tools 放进
  // completionOptions —— 所以「completionOptions.tools 为空」即「使用 system-tools 框架」。
  const useSystemToolsFramework = !request.completionOptions.tools?.length;
  const framework = useSystemToolsFramework
    ? new SystemMessageToolCodeblocksFramework()
    : undefined;

  const { messages } = constructMessages(
    history,
    request.systemMessage,
    request.rules,
    request.ruleSettings,
    framework,
    request.conversationSummaryOverride !== undefined
      ? { conversationSummaryOverride: request.conversationSummaryOverride }
      : undefined,
  );

  return {
    metrics: measure(messages, request.completionOptions),
    // 身份由发起方（GUI）计算并回传：Core 不猜 active model，也不重算构造身份。
    meta: {
      conversationRevision: request.conversationRevision,
      constructionIdentity: request.constructionIdentity,
      schemaVersion: request.schemaVersion,
    },
  };
}

/**
 * 请求携带的 schema 版本是否与本 Core 一致。不一致时**不计量**（既不写 metrics 也不回传
 * Result）：两个版本的 identity 语义不可比较，写入磁盘只会制造"看起来 fresh 的错值"。
 */
export function measurementSchemaMatches(
  request: FullConversationMeasurementRequest,
): boolean {
  return request.schemaVersion === FULL_CONVERSATION_METRICS_SCHEMA_VERSION;
}
