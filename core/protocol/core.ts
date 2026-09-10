import {
  BlockType,
  ConfigResult,
  DevDataLogEvent,
  ModelRole,
} from "@continuedev/config-yaml";
import { ToolPolicy } from "@continuedev/terminal-security";

import {
  AutocompleteInput,
  RecentlyEditedRange,
} from "../autocomplete/util/types";
import { ProfileDescription } from "../config/ProfileLifecycleManager";
import { SharedConfigSchema } from "../config/sharedConfig";
import { GlobalContextModelSelections } from "../util/GlobalContext";

import {
  BaseSessionMetadata,
  BrowserSerializedContinueConfig,
  ChatHistoryItem,
  ChatMessage,
  CompiledMessagesResult,
  CompleteOnboardingPayload,
  ContextItem,
  ContextItemWithId,
  ContextSubmenuItem,
  DiffLine,
  DocsIndexingDetails,
  ExperimentalModelRoles,
  FileSymbolMap,
  IdeSettings,
  LLMFullCompletionOptions,
  McpUiState,
  MessageOption,
  ModelDescription,
  PromptLog,
  RangeInFile,
  RangeInFileWithNextEditInfo,
  SerializedContinueConfig,
  Session,
  SiteIndexingConfig,
  SlashCommandDescWithSource,
  StreamDiffLinesPayload,
  ToolCall,
} from "../";
import { AutocompleteCodeSnippet } from "../autocomplete/snippets/types";
import { GetLspDefinitionsFunction } from "../autocomplete/types";
import { ConfigHandler } from "../config/ConfigHandler";
import { ProcessedItem } from "../nextEdit/NextEditPrefetchQueue";
import { NextEditOutcome } from "../nextEdit/types";
import { ContinueErrorReason } from "../util/errors";

export enum OnboardingModes {
  API_KEY = "API Key",
  LOCAL = "Local",
}

export interface ListHistoryOptions {
  offset?: number;
  limit?: number;
  workspaceDirectory?: string;
}

export interface HistorySearchResult {
  sessionId: string;
  title: string;
  snippet: string;
}

export interface LoadPageHistoryRequest {
  id: string;
  // 从末尾算起的偏移：0 = 最新一轮，N = 跳过最新 N 条之后开始
  offset: number;
  // 要加载的条数
  limit: number;
}

/**
 * 方案.md §七.8.1: `history/save` returns the authoritative post-merge data.
 * GUI 只在 success 后更新，绝不从 truncated window 重算。
 */
export interface SaveHistoryResponse {
  /**
   * 磁盘首轮原始条目（未经 GUI bubble merge）。
   *
   * **必填，且是权威结果**：完整保存之后磁盘上是否有可提取的首轮是一个确定的
   * 事实，Core 每次都计算，因此这里没有省略的余地。`[]` 是合法权威值，表示保存后的
   * 完整 history 中不存在可提取的 user 起始首轮 —— 即整段 history 里**没有任何 user
   * 消息**。（不是"首条不是 user 消息"：提取器会在整段 history 中查找第一条 user，
   * 因此 `[assistant, thinking, user, assistant]` 仍然能提取出首轮。）
   * 不要把它改成 optional 来掩盖协议未同步 —— GUI 在 success 之后正是用它整体覆盖
   * 本地值（含清空）。
   */
  firstTurnItems: ChatHistoryItem[];
  latestConversationSummary?: {
    sourceMessageId: string;
    sourceAbsoluteIndex: number;
    content: string;
  };
  /** 合并后的完整 history 条数（含磁盘冻结头部）。 */
  totalHistoryCount: number;
  /**
   * 该 session 在磁盘 `sessions.json` 里的权威元数据（方案.md §五.6/§七.8.1）。
   *
   * Core 写盘时本来就要构造/更新这一条，所以把**同一个对象**一起返回，GUI 不必
   * 自己猜：`dateCreated` 是 Core 的创建时间（重写已有条目时**不**改），
   * `messageCount` 是 Core 基于**完整** final history 算出的真实条数 —— 懒加载窗口
   * 既算不出这两个值，也不该拿 `Date.now()` 冒充创建时间。
   *
   * 用途：会话第一次成功落盘时把 catalog entry 插进
   * `sessionCatalog.allSessionMetadata`，让 View History 不必等下一次全量
   * `history/list`（这正是"新会话关闭后不可见、reload 后才出现"的根因）。
   *
   * **可选，仅为兼容旧宿主**（刻意与 `firstTurnItems` 的必填语义不同）：
   * 旧 Core 不返回该字段。缺失是**安全的空操作** —— GUI 保持 catalog 不变、等下次
   * 启动的 `history/list` 归一，不会留下过期权威值。但 GUI **不得**在缺失时自己
   * 构造 metadata（猜 dateCreated / 用可见窗口估 messageCount）。
   */
  sessionMetadata?: BaseSessionMetadata;
}

export interface LoadPageHistoryResponse {
  items: ChatHistoryItem[];
  /**
   * 磁盘首轮原始条目（方案.md §五.5/§十三.4）。
   *
   * Core 在 `offset === 0` 时返回提取出的磁盘首轮；**非首屏返回 `[]`，而不是省略
   * 该字段**（`latestConversationSummary` 才是非首屏直接 `undefined`）。旧宿主则
   * 可能完全省略该字段 —— 协议层因此是 optional。
   *
   * **可选，仅为兼容旧宿主**（与 `SaveHistoryResponse.firstTurnItems` 的必填语义
   * 刻意不同，不要统一）：
   * - `undefined` = 该宿主尚未实现这个字段。GUI 必须按"首轮不可用"处理，
   *   归一化为 `[]` 后让请求历史走全量加载回退，**不得**据此推断"这是新会话"。
   * - `[]` = 无首轮：可能是宿主明确返回的空首轮，也可能是非首屏，也可能是旧宿主
   *   省略后被归一化的结果。它与 `undefined` 共享同一条安全回退（全量加载），
   *   当前实现因此不引入额外的状态枚举来区分它们。
   * - GUI 也不得仅凭数组长度判断会话状态或"可靠首轮"：可靠性的另外两个条件是
   *   `persistence.hasPersistedBaseline` 与 `persistence.state !== "failed"`。
   */
  firstTurnItems?: ChatHistoryItem[];
  /**
   * 权威摘要（方案.md §七.8.1/§十一）：懒加载激活时用它恢复
   * `latestConversationSummary`，否则 Local Provider 的
   * `conversationSummaryOverride` 在重启后会变成 undefined。
   * 仅 offset === 0 时返回。
   */
  latestConversationSummary?: {
    sourceMessageId: string;
    sourceAbsoluteIndex: number;
    content: string;
  };
  hasMore: boolean;
  total: number;
  session: Pick<
    Session,
    | "title"
    | "mode"
    | "chatModelTitle"
    | "workspaceDirectory"
    | "contextMetrics"
    | "hasReasoningEnabled"
    | "reasoningPreferenceSource"
  >;
}

export type ToCoreFromIdeOrWebviewProtocol = {
  // Special
  ping: [string, string];
  abort: [undefined, void];
  cancelApply: [undefined, void];

  // History
  "history/list": [ListHistoryOptions, BaseSessionMetadata[]];
  "history/delete": [{ id: string }, void];
  "history/load": [{ id: string }, Session];
  "history/loadPage": [LoadPageHistoryRequest, LoadPageHistoryResponse];
  "history/searchContent": [{ query: string }, HistorySearchResult[]];
  "history/save": [Session, SaveHistoryResponse];
  "history/share": [{ id: string; outputDir?: string }, void];
  "history/clear": [undefined, void];
  "devdata/log": [DevDataLogEvent, void];
  "config/addOpenAiKey": [string, void];
  "config/addModel": [
    {
      model: SerializedContinueConfig["models"][number];
      role?: keyof ExperimentalModelRoles;
    },
    void,
  ];
  "config/addLocalWorkspaceBlock": [
    { blockType: BlockType; baseFilename?: string },
    void,
  ];
  "config/addGlobalRule": [undefined | { baseFilename?: string }, void];
  "config/deleteRule": [{ filepath: string }, void];
  "config/newPromptFile": [undefined, void];
  "config/newAssistantFile": [undefined, void];
  "config/ideSettingsUpdate": [IdeSettings, void];
  "config/getSerializedProfileInfo": [
    undefined,
    {
      result: ConfigResult<BrowserSerializedContinueConfig>;
      profileId: string | null;
      profiles: ProfileDescription[];
    },
  ];
  "config/deleteModel": [{ title: string }, void];
  "config/refreshProfiles": [
    (
      | undefined
      | {
          reason?: string;
          selectProfileId?: string;
        }
    ),
    void,
  ];
  "config/openProfile": [{ profileId: string | undefined }, void];
  "config/updateSharedConfig": [SharedConfigSchema, SharedConfigSchema];
  "config/updateSelectedModel": [
    {
      profileId: string;
      role: ModelRole;
      title: string | null;
    },
    GlobalContextModelSelections,
  ];
  "context/getContextItems": [
    {
      name: string;
      query: string;
      fullInput: string;
      selectedCode: RangeInFile[];
      isInAgentMode: boolean;
    },
    ContextItemWithId[],
  ];

  "mcp/reloadServer": [
    {
      id: string;
    },
    void,
  ];
  "mcp/setServerEnabled": [{ id: string; enabled: boolean }, void];
  "mcp/getPrompt": [
    {
      serverName: string;
      promptName: string;
      args?: Record<string, string>;
    },
    {
      prompt: string;
      description: string | undefined;
    },
  ];
  "mcp/startAuthentication": [
    {
      serverId: string;
      serverUrl: string;
    },
    void,
  ];
  "mcp/removeAuthentication": [
    {
      serverId: string;
      serverUrl: string;
    },
    void,
  ];
  // Reconnect unhealthy MCP servers before a message is sent; returns true if
  // any connection changed state (config/tools may have been reloaded).
  "mcp/ensureConnections": [undefined, boolean];
  "context/getSymbolsForFiles": [{ uris: string[] }, FileSymbolMap];
  "context/loadSubmenuItems": [{ title: string }, ContextSubmenuItem[]];
  "autocomplete/complete": [AutocompleteInput, string[]];
  "context/addDocs": [SiteIndexingConfig, void];
  "context/removeDocs": [Pick<SiteIndexingConfig, "startUrl">, void];
  "context/indexDocs": [{ reIndex: boolean }, void];
  "autocomplete/cancel": [undefined, void];
  "autocomplete/accept": [{ completionId: string }, void];
  "nextEdit/predict": [
    {
      input: AutocompleteInput;
      options?: {
        withChain?: boolean;
        usingFullFileDiff?: boolean;
      };
    },
    NextEditOutcome | undefined,
  ];
  "nextEdit/reject": [{ completionId: string }, void];
  "nextEdit/accept": [{ completionId: string }, void];
  "nextEdit/startChain": [undefined, void];
  "nextEdit/deleteChain": [undefined, void];
  "nextEdit/isChainAlive": [undefined, boolean];
  "nextEdit/queue/getProcessedCount": [undefined, number];
  "nextEdit/queue/dequeueProcessed": [undefined, ProcessedItem | null];
  "nextEdit/queue/processOne": [
    {
      ctx: {
        completionId: string;
        manuallyPassFileContents?: string;
        manuallyPassPrefix?: string;
        selectedCompletionInfo?: {
          text: string;
          range: Range;
        };
        isUntitledFile: boolean;
        recentlyVisitedRanges: AutocompleteCodeSnippet[];
        recentlyEditedRanges: RecentlyEditedRange[];
      };
      recentlyVisitedRanges: AutocompleteCodeSnippet[];
      recentlyEditedRanges: RecentlyEditedRange[];
    },
    void,
  ];
  "nextEdit/queue/clear": [undefined, void];
  "nextEdit/queue/abort": [undefined, void];
  "llm/complete": [
    {
      prompt: string;
      completionOptions: LLMFullCompletionOptions;
      title: string;
    },
    string,
  ];
  "llm/listModels": [{ title: string }, string[] | undefined];
  "llm/streamChat": [
    {
      messages: ChatMessage[];
      completionOptions: LLMFullCompletionOptions;
      title: string;
      messageOptions?: MessageOption;
      legacySlashCommandData?: {
        command: SlashCommandDescWithSource;
        input: string;
        contextItems: ContextItemWithId[];
        historyIndex: number;
        selectedCode: RangeInFile[];
      };
    },
    AsyncGenerator<ChatMessage, PromptLog>,
  ];
  streamDiffLines: [StreamDiffLinesPayload, AsyncGenerator<DiffLine>];
  getDiffLines: [{ oldContent: string; newContent: string }, DiffLine[]];
  "llm/compileChat": [
    {
      messages: ChatMessage[];
      options: LLMFullCompletionOptions;
      /**
       * 方案.md §十四: message indexes that must not be pruned. Local Provider
       * requests protect the whole array (system + first turn + current turn),
       * so an over-budget request fails as out-of-context instead of silently
       * dropping the first turn.
       */
      protectedMessageIndexes?: number[];
    },
    CompiledMessagesResult,
  ];
  "chatDescriber/describe": [
    {
      // 请求归属与诊断身份（方案.md §七.10）。Core 没有 GUI 的 sessionsById
      // 注册表，故 sessionId 不用于反查会话或模型，仅用于明确归属与错误归因。
      sessionId: string;
      // Core 的模型解析依据：必须在 config.modelsByRole.chat 中精确命中。
      // 目标会话的模型由 GUI 决定，因此 Core 不设回退（见 core.ts handler）。
      modelTitle: string;
      text: string;
      // 传完整会话历史，让服务端能识别这不是新会话（服务端按历史判断）
      messages?: ChatMessage[];
    },
    string | undefined,
  ];
  "conversation/compact": [
    {
      index: number;
      sessionId: string;
    },
    string | undefined,
  ];
  "stats/getTokensPerDay": [
    undefined,
    { day: string; promptTokens: number; generatedTokens: number }[],
  ];
  "stats/getTokensPerModel": [
    undefined,
    { model: string; promptTokens: number; generatedTokens: number }[],
  ];
  "tts/kill": [undefined, void];

  // Codebase indexing
  "index/setPaused": [boolean, void];
  "index/forceReIndex": [
    undefined | { dirs?: string[]; shouldClearIndexes?: boolean },
    void,
  ];
  "index/indexingProgressBarInitialized": [undefined, void];
  "onboarding/complete": [CompleteOnboardingPayload, void];

  // File changes
  "files/changed": [{ uris?: string[] }, void];
  "files/opened": [{ uris?: string[] }, void];
  "files/created": [{ uris?: string[] }, void];
  "files/deleted": [{ uris?: string[] }, void];
  "files/closed": [{ uris?: string[] }, void];
  "files/smallEdit": [
    {
      actions: RangeInFileWithNextEditInfo[];
      configHandler: ConfigHandler;
      getDefsFromLspFunction: GetLspDefinitionsFunction;
      recentlyEditedRanges: RecentlyEditedRange[];
      recentlyVisitedRanges: AutocompleteCodeSnippet[];
    },
    void,
  ];

  // Docs etc. Indexing. TODO move codebase to this
  "indexing/reindex": [{ type: string; id: string }, void];
  "indexing/abort": [{ type: string; id: string }, void];
  "indexing/setPaused": [{ type: string; id: string; paused: boolean }, void];
  "docs/getSuggestedDocs": [undefined, void];
  "docs/initStatuses": [undefined, void];
  "docs/getDetails": [{ startUrl: string }, DocsIndexingDetails];
  "docs/getIndexedPages": [{ startUrl: string }, string[]];
  addAutocompleteModel: [{ model: ModelDescription }, void];

  "auth/getAuthUrl": [{ useOnboarding: boolean }, { url: string }];
  "tools/call": [
    { toolCall: ToolCall },
    {
      contextItems: ContextItem[];
      errorMessage?: string;
      errorReason?: ContinueErrorReason;
      mcpUiState?: McpUiState;
    },
  ];
  "tools/evaluatePolicy": [
    {
      toolName: string;
      basePolicy: ToolPolicy;
      parsedArgs: Record<string, unknown>;
      processedArgs?: Record<string, unknown>;
    },
    { policy: ToolPolicy; displayValue?: string },
  ];
  "tools/preprocessArgs": [
    { toolName: string; args: Record<string, unknown> },
    {
      preprocessedArgs?: Record<string, unknown>;
      errorReason?: ContinueErrorReason;
      errorMessage?: string;
    },
  ];
  "clipboardCache/add": [{ content: string }, void];
  isItemTooBig: [{ item: ContextItemWithId }, boolean];
  "process/markAsBackgrounded": [{ toolCallId: string }, void];
  "process/isBackgrounded": [{ toolCallId: string }, boolean];
  "process/killTerminalProcess": [{ toolCallId: string }, void];
  "mdm/setLicenseKey": [{ licenseKey: string }, boolean];
  "models/fetch": [
    { provider: string; apiKey?: string; apiBase?: string },
    {
      name: string;
      modelId?: string;
      description?: string;
      icon?: string;
      popular?: boolean;
      contextLength?: number;
      maxTokens?: number;
      supportsTools?: boolean;
    }[],
  ];
};
