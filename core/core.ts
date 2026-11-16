import { fetchwithRequestOptions } from "@continuedev/fetch";
import * as URI from "uri-js";
import { v4 as uuidv4 } from "uuid";

import { CompletionProvider } from "./autocomplete/CompletionProvider";
import {
  openedFilesLruCache,
  prevFilepaths,
} from "./autocomplete/util/openedFilesLruCache";
import { ConfigHandler } from "./config/ConfigHandler";
import { addModel, deleteModel } from "./config/util";
import { DevDataSqliteDb } from "./data/devdataSqlite";
import { DataLogger } from "./data/log";
import { CodebaseIndexer } from "./indexing/CodebaseIndexer";
import DocsService from "./indexing/docs/DocsService";
import { countTokens } from "./llm/countTokens";
import type { ChatMessage, LLMFullCompletionOptions } from "./index.js";
import Lemonade from "./llm/llms/Lemonade";
import { fetchModels } from "./llm/fetchModels";
import Ollama from "./llm/llms/Ollama";
import { EditAggregator } from "./nextEdit/context/aggregateEdits";
import { createNewPromptFileV2 } from "./promptFiles/createNewPromptFile";
import { callTool } from "./tools/callTool";
import { ChatDescriber } from "./util/chatDescriber";
import { compactConversation } from "./util/conversationCompaction";
import { forkConversation } from "./util/conversationFork";
import { searchSessionContent } from "./util/historySearch";
import { GlobalContext } from "./util/GlobalContext";
import historyManager from "./util/history";
import {
  measureFullConversation,
  measurementSchemaMatches,
} from "./util/fullConversationMeasurement.js";
import { FULL_CONVERSATION_METRICS_SCHEMA_VERSION } from "./util/fullConversationMetrics.js";
import { editConfigFile, migrateV1DevDataFiles } from "./util/paths";

import {
  isProcessBackgrounded,
  killTerminalProcess,
  markProcessAsBackgrounded,
} from "./util/processTerminalStates";
import { getSymbolsForManyFiles } from "./util/treeSitter";
import { TTS } from "./util/tts";

import {
  CompleteOnboardingPayload,
  ContextItemId,
  ContextItemWithId,
  IdeSettings,
  ModelDescription,
  Position,
  RangeInFile,
  SessionChatModelRef,
  ToolCall,
  type ContextItem,
  type IDE,
  type ILLM,
} from ".";

import { ConfigYaml } from "@continuedev/config-yaml";
import { getDiffFn, GitDiffCache } from "./autocomplete/snippets/gitDiffCache";
import { stringifyMcpPrompt } from "./commands/slash/mcpSlashCommand";
import { createNewAssistantFile } from "./config/createNewAssistantFile";
import {
  isColocatedRulesFile,
  isContinueAgentConfigFile,
  isContinueConfigRelatedUri,
} from "./config/loadLocalAssistants";
import { CodebaseRulesCache } from "./config/markdown/loadCodebaseRules";
import {
  setupLocalConfig,
  setupProviderConfig,
  setupQuickstartConfig,
} from "./config/onboarding";
import {
  createNewGlobalRuleFile,
  createNewWorkspaceBlockFile,
} from "./config/workspace/workspaceBlocks";
import { MCPManagerSingleton } from "./context/mcp/MCPManagerSingleton";
import { performAuth, removeMCPAuth } from "./context/mcp/MCPOauth";
import { myersDiff } from "./diff/myers";
import { ApplyAbortManager } from "./edit/applyAbortManager";
import { streamDiffLines } from "./edit/streamDiffLines";
import { shouldIgnore } from "./indexing/shouldIgnore";
import { walkDirCache } from "./indexing/walkDir";
import { LLMLogger } from "./llm/logger";
import { llmStreamChat } from "./llm/streamChat";
import { BeforeAfterDiff } from "./nextEdit/context/diffFormatting";
import { processSmallEdit } from "./nextEdit/context/processSmallEdit";
import { PrefetchQueue } from "./nextEdit/NextEditPrefetchQueue";
import { NextEditProvider } from "./nextEdit/NextEditProvider";
import type { FromCoreProtocol, ToCoreProtocol } from "./protocol";
import { OnboardingModes } from "./protocol/core";
import type { IMessenger, Message } from "./protocol/messenger";
import { ContinueError, ContinueErrorReason } from "./util/errors";
import { shareSession } from "./util/historyUtils";
import { Logger } from "./util/Logger.js";
import { resolveCoreRequestChatModel } from "./util/sessionChatModel";

export class Core {
  configHandler: ConfigHandler;
  codeBaseIndexer: CodebaseIndexer;
  completionProvider: CompletionProvider;
  nextEditProvider: NextEditProvider;
  private docsService: DocsService;
  private globalContext = new GlobalContext();
  llmLogger = new LLMLogger();

  private messageAbortControllers = new Map<string, AbortController>();
  private addMessageAbortController(id: string): AbortController {
    const controller = new AbortController();
    this.messageAbortControllers.set(id, controller);
    controller.signal.addEventListener("abort", () => {
      this.messageAbortControllers.delete(id);
    });
    return controller;
  }
  private abortById(messageId: string) {
    this.messageAbortControllers.get(messageId)?.abort();
  }

  invoke<T extends keyof ToCoreProtocol>(
    messageType: T,
    data: ToCoreProtocol[T][0],
  ): ToCoreProtocol[T][1] {
    return this.messenger.invoke(messageType, data);
  }

  send<T extends keyof FromCoreProtocol>(
    messageType: T,
    data: FromCoreProtocol[T][0],
    messageId?: string,
  ): string {
    return this.messenger.send(messageType, data, messageId);
  }

  // TODO: It shouldn't actually need an IDE type, because this can happen
  // through the messenger (it does in the case of any non-VS Code IDEs already)
  constructor(
    private readonly messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>,
    private readonly ide: IDE,
  ) {
    try {
      // Ensure .continue directory is created
      migrateV1DevDataFiles();

      const ideInfoPromise = messenger.request("getIdeInfo", undefined);
      const ideSettingsPromise = messenger.request("getIdeSettings", undefined);
      this.configHandler = new ConfigHandler(this.ide, this.llmLogger);

      this.docsService = DocsService.createSingleton(
        this.configHandler,
        this.ide,
        this.messenger,
      );

      MCPManagerSingleton.getInstance().onConnectionsRefreshed = () => {
        void this.configHandler.reloadConfig("MCP Connections refreshed");

        // Refresh @mention dropdown submenu items for MCP providers
        const mcpManager = MCPManagerSingleton.getInstance();
        const mcpProviderNames = Array.from(mcpManager.connections.keys()).map(
          (mcpId) => `mcp-${mcpId}`,
        );

        if (mcpProviderNames.length > 0) {
          this.messenger.send("refreshSubmenuItems", {
            providers: mcpProviderNames,
          });
        }
      };

      this.codeBaseIndexer = new CodebaseIndexer(
        this.configHandler,
        this.ide,
        this.messenger,
        this.globalContext.get("indexingPaused"),
      );

      this.configHandler.onConfigUpdate((result) => {
        void (async () => {
          const serializedResult =
            await this.configHandler.getSerializedConfig();
          this.messenger.send("configUpdate", {
            result: serializedResult,
            profileId:
              this.configHandler.currentProfile?.profileDescription.id || null,
            profiles: this.configHandler.profileDescriptions,
          });

          if (await this.codeBaseIndexer.wasAnyOneIndexAdded()) {
            await this.codeBaseIndexer.refreshCodebaseIndex(
              await this.ide.getWorkspaceDirs(),
            );
          }

          // update additional submenu context providers registered via VSCode API
          const additionalProviders =
            this.configHandler.getAdditionalSubmenuContextProviders();
          if (additionalProviders.length > 0) {
            this.messenger.send("refreshSubmenuItems", {
              providers: additionalProviders,
            });
          }
        })();
      });

      // Dev Data Logger
      const dataLogger = DataLogger.getInstance();
      dataLogger.core = this;
      dataLogger.ideInfoPromise = ideInfoPromise;
      dataLogger.ideSettingsPromise = ideSettingsPromise;

      void ideSettingsPromise.then((ideSettings) => {
        // Index on initialization
        void this.ide.getWorkspaceDirs().then(async (dirs) => {
          // Respect pauseCodebaseIndexOnStart user settings
          if (ideSettings.pauseCodebaseIndexOnStart) {
            this.codeBaseIndexer.paused = true;
            void this.messenger.request("indexProgress", {
              progress: 0,
              desc: "Initial Indexing Skipped",
              status: "paused",
            });
            return;
          }

          // Check for disableIndexing to prevent race condition
          const { config } = await this.configHandler.loadConfig();
          if (!config || config.disableIndexing) {
            void this.messenger.request("indexProgress", {
              progress: 0,
              desc: "Indexing is disabled",
              status: "disabled",
            });
            return;
          }

          void this.codeBaseIndexer.refreshCodebaseIndex(dirs);
        });
      });

      const getLlm = async () => {
        const { config } = await this.configHandler.loadConfig();
        if (!config) {
          return undefined;
        }
        return config.selectedModelByRole.autocomplete ?? undefined;
      };
      this.completionProvider = new CompletionProvider(
        this.configHandler,
        ide,
        getLlm,
        (e) => {},
        (..._) => Promise.resolve([]),
      );

      const codebaseRulesCache = CodebaseRulesCache.getInstance();
      void codebaseRulesCache
        .refresh(ide)
        .catch((e) =>
          Logger.error("Failed to initialize colocated rules cache"),
        )
        .then(() => {
          void this.configHandler.reloadConfig(
            "Initial codebase rules post-walkdir/load reload",
          );
        });
      this.nextEditProvider = NextEditProvider.initialize(
        this.configHandler,
        ide,
        getLlm,
        (e) => {},
        (..._) => Promise.resolve([]),
        "fineTuned",
      );

      this.registerMessageHandlers(ideSettingsPromise);
    } catch (error) {
      Logger.error(error);
      throw error; // Re-throw to prevent partially initialized core
    }
  }

  /* eslint-disable max-lines-per-function */
  private registerMessageHandlers(ideSettingsPromise: Promise<IdeSettings>) {
    const on = this.messenger.on.bind(this.messenger);

    // Note, VsCode's in-process messenger doesn't do anything with this
    // It will only show for jetbrains
    this.messenger.onError((message, err) => {
      // just to prevent duplicate error messages in jetbrains (same logic in webview protocol)
      if (
        ["llm/streamChat", "chatDescriber/describe"].includes(
          message.messageType,
        )
      ) {
        return;
      } else {
        void this.ide.showToast("error", err.message);
      }
    });

    on("abort", (msg) => {
      this.abortById(msg.data ?? msg.messageId);
    });

    on("ping", (msg) => {
      if (msg.data !== "ping") {
        throw new Error("ping message incorrect");
      }
      return "pong";
    });

    // History
    on("history/list", async (msg) => {
      const sessions = historyManager.list(msg.data);
      const limit = msg.data?.limit ?? 100;
      return sessions.slice(0, limit);
    });

    on("history/delete", async (msg) => {
      // save/delete 现为异步（跨进程锁不再阻塞事件循环）。保持错误向上传播，
      // 与旧同步实现一致：gui 侧 await request("history/delete") 会收到该错误。
      await historyManager.delete(msg.data.id);
    });

    on("history/load", (msg) => {
      return historyManager.load(msg.data.id);
    });

    on("history/loadPage", (msg) => {
      const { id, offset, limit } = msg.data;
      return historyManager.loadPage(id, offset, limit);
    });

    on("history/searchContent", (msg) => {
      return searchSessionContent(msg.data.query);
    });

    /**
     * 方案.md §五.16.7：按 title 显式解析聊天模型，供保存锁内计量与只读计量共用。
     *
     * 刻意不回退 `selectedModelByRole.chat`（那是 profile 级全局选择，可能属于另一个 tab，
     * §七.10 的同一条教训）。匹配用 `title ?? model`，因为
     * `llmToSerializedModelDescription` 就是那么投影的，而 `ILLM.title` 可选。
     */
    const resolveMeasurementModel = async (modelTitle: string) => {
      const { config } = await this.configHandler.loadConfig();
      const targetModel = config?.modelsByRole.chat.find(
        (model) => (model.title ?? model.model) === modelTitle,
      );
      // The GUI's debug switch rides along: the same setting that enables `[submit-latency]`
      // in the webview console also enables the save's phase breakdown here (扩展宿主
      // DevTools). 方案.md §7.2.2.
      return {
        targetModel,
        logTimings: config?.ui?.showSubmitLatencyLogs === true,
      };
    };

    /**
     * 方案.md §7.5.4：**发送路径**的模型解析，`llm/compileChat` 与 `llm/streamChat` 共用。
     *
     * 这是"两个解析口径"问题的收口点：GUI 已经用 `resolveSessionChatModel` 决定了会话属于哪个
     * 模型，Core 这边只把它**执行**出来 —— 同一个纯函数、同一条优先级、同样的失败语义。因此
     * compile 与 stream 一定落在同一个模型上，而不是一个按 `selectedModelByRole.chat`（profile
     * 默认，可能属于另一个 tab）编译、另一个按 turn 的 ref 发送。
     *
     * Fail-closed 的规则本身在 `resolveCoreRequestChatModel`（`util/sessionChatModel.ts`）：
     * 带 ref ⇒ 只按 ref 唯一命中；不带 ref ⇒ 旧协议按 title 唯一命中（显式分叉）；两种情况
     * 0/多命中都抛错，**绝不**回退 profile 默认、**绝不**再按 title 猜一次。
     *
     * 日志只写 ref 的三个字段（就是工具栏显示的那三个）：没有 key、没有 endpoint、没有 prompt。
     */
    const resolveRequestChatModel = async (request: {
      modelRef?: SessionChatModelRef;
      title?: string;
    }): Promise<ILLM> => {
      const { config } = await this.configHandler.loadConfig();
      const models = config?.modelsByRole.chat ?? [];
      if (models.length === 0) {
        throw new Error("No chat model selected");
      }
      const model = resolveCoreRequestChatModel(models, request);
      if (!model) {
        throw new Error("No chat model selected");
      }
      return model;
    };

    on("history/save", async (msg) => {
      // 异步保存；错误向上传播（gui 侧 await request("history/save")）。
      const { fullConversationMeasurement: measurement } = msg.data;

      // 不带计量 = 只保存：不量化、也不改动磁盘上已有的 metrics。
      //
      // 即使不计量也要知道 debug 开关：真实 trace 里一次「不计量」的保存等了 4.3s，而带计量的
      // 那次只用了 770ms —— 只给计量路径记时会让最大的那个数字没有 Core 侧对照。
      if (!measurement) {
        const { config } = await this.configHandler.loadConfig();
        return historyManager.save(msg.data, {
          logTimings: config?.ui?.showSubmitLatencyLogs === true,
        });
      }

      // 方案.md §五.16.7 / §7.1.2: 计量输入里 GUI 不可见的那部分（tokenizer 键、解析后的
      // 窗口、图片能力、tool-output 排除规则）来自**按标题显式解析**的模型。
      //
      // 解析失败 / schema 不一致都**不阻断保存**：保存是数据完整性路径，计量只是派生值。
      // 此时不写 metrics、不回传 Result，GUI 保留 last-known 数值并等待下一次计量。
      const { targetModel, logTimings } = await resolveMeasurementModel(
        measurement.modelTitle,
      );
      if (!targetModel) {
        console.warn(
          `[history/save] full-conversation measurement skipped: model not found for title "${measurement.modelTitle}"`,
        );
        return historyManager.save(msg.data, { logTimings });
      }
      if (!measurementSchemaMatches(measurement)) {
        console.warn(
          `[history/save] full-conversation measurement skipped: schema ${measurement.schemaVersion} !== ${FULL_CONVERSATION_METRICS_SCHEMA_VERSION}`,
        );
        return historyManager.save(msg.data, { logTimings });
      }

      return historyManager.save(msg.data, {
        logTimings,
        measureFullConversation: (finalHistory) =>
          measureFullConversation({
            history: finalHistory,
            request: measurement,
            measure: (
              messages: ChatMessage[],
              options: LLMFullCompletionOptions,
            ) => targetModel.measureChatMessagesNoPrune(messages, options),
          }),
      });
    });

    /**
     * 方案.md §五.16.5/§九.7.1：**只读**计量重算。读磁盘上的完整 history（不是 GUI 窗口），
     * 用请求里显式的构造与计量输入计量，返回 Result，**不修改磁盘**。
     *
     * 与保存路径的差别只在失败语义：这里是纯粹的计量请求，没有"必须成功"的数据完整性职责，
     * 所以模型解析失败 / schema 不一致一律抛出 —— GUI 会保留 last-known 数值并保持 stale，
     * 而不是拿到一个用错输入算出来的"新鲜"值。
     */
    on("history/measureConversation", async (msg) => {
      const { sessionId, measurement } = msg.data;

      if (!measurementSchemaMatches(measurement)) {
        throw new Error(
          `history/measureConversation: unsupported measurement schema ${measurement.schemaVersion}`,
        );
      }
      const { targetModel } = await resolveMeasurementModel(
        measurement.modelTitle,
      );
      if (!targetModel) {
        throw new Error(
          `history/measureConversation: model not found for title "${measurement.modelTitle}"`,
        );
      }

      const session = historyManager.load(sessionId);
      return measureFullConversation({
        history: session.history,
        request: measurement,
        measure: (messages: ChatMessage[], options: LLMFullCompletionOptions) =>
          targetModel.measureChatMessagesNoPrune(messages, options),
      });
    });

    on("history/migrateIds", async (msg) => {
      // legacy message ID 具名迁移（P3）：只补缺失的 message.id，不改变其他字段。
      // 失败以 SessionPersistenceError 抛出 → 宿主映射成 errorCode。
      return historyManager.migrateMessageIds(msg.data.id);
    });

    on("history/share", async (msg) => {
      const session = historyManager.load(msg.data.id);
      const outputDir = msg.data.outputDir;
      const history = session.history.map((msg) => msg.message);
      await shareSession(this.ide, history, outputDir);
    });

    on("history/clear", (msg) => {
      historyManager.clearAll();
    });

    on("devdata/log", async (msg) => {
      void DataLogger.getInstance().logDevData(msg.data);
    });

    on("config/addModel", async (msg) => {
      const model = msg.data.model;
      const { config } = await this.configHandler.loadConfig();
      const allModels = Object.values(config?.modelsByRole ?? {}).flat();
      const existing = allModels.find(
        (m) => m.providerName === model.provider && m.model === model.model,
      );
      if (existing) {
        void this.ide.showToast(
          "warning",
          "Model already exists in config. Update the API key in the config file.",
        );
        await this.configHandler.openConfigProfile();
        return;
      }
      addModel(model, msg.data.role);
      void this.configHandler.reloadConfig(
        "Model added (config/addModel message)",
      );
    });

    on("config/deleteModel", (msg) => {
      deleteModel(msg.data.title);
      void this.configHandler.reloadConfig(
        "Model removed (config/deleteModel message)",
      );
    });

    on("config/newPromptFile", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      await createNewPromptFileV2(this.ide, config?.experimental?.promptPath);
      await this.configHandler.reloadConfig(
        "Prompt file created (config/newPromptFile message)",
      );
    });

    on("config/newAssistantFile", async (msg) => {
      await createNewAssistantFile(this.ide, undefined);
      await this.configHandler.refreshAll(
        "Assistant file created (config/newAssistantFile message)",
      );
    });

    on("config/addLocalWorkspaceBlock", async (msg) => {
      await createNewWorkspaceBlockFile(
        this.ide,
        msg.data.blockType,
        msg.data.baseFilename,
      );
      walkDirCache.invalidate();
      await this.configHandler.reloadConfig(
        "Local block created (config/addLocalWorkspaceBlock message)",
      );
    });

    on("config/addGlobalRule", async (msg) => {
      try {
        await createNewGlobalRuleFile(this.ide, msg.data?.baseFilename);
        walkDirCache.invalidate();
        await this.configHandler.reloadConfig(
          "Global rule created (config/addGlobalRule message)",
        );
      } catch (error) {
        throw error;
      }
    });

    on("config/deleteRule", async (msg) => {
      try {
        const filepath = msg.data.filepath;
        if (
          !isColocatedRulesFile(filepath) &&
          !isContinueConfigRelatedUri(filepath)
        ) {
          throw new Error("Only rule files can be deleted");
        }
        const fileExists = await this.ide.fileExists(filepath);
        if (fileExists) {
          await this.ide.removeFile(filepath);
          walkDirCache.invalidate();
          await this.configHandler.reloadConfig(
            "Rule file deleted (config/deleteRule message)",
          );
        }
      } catch (error) {
        console.error("Failed to delete rule file:", error);
        throw error;
      }
    });

    on("config/openProfile", async (msg) => {
      await this.configHandler.openConfigProfile(msg.data.profileId);
    });

    on("config/ideSettingsUpdate", async (msg) => {
      await this.configHandler.updateIdeSettings(msg.data);
    });

    on("config/refreshProfiles", async (msg) => {
      // User force reloading will retrigger colocated rules
      const codebaseRulesCache = CodebaseRulesCache.getInstance();
      await codebaseRulesCache.refresh(this.ide);

      const { selectProfileId, reason } = msg.data ?? {};
      await this.configHandler.refreshAll(reason);
      if (selectProfileId) {
        await this.configHandler.setSelectedProfileId(selectProfileId);
      }
    });

    on("config/updateSharedConfig", async (msg) => {
      const newSharedConfig = this.globalContext.updateSharedConfig(msg.data);
      await this.configHandler.reloadConfig(
        "Shared config update (config/updateSharedConfig message)",
      );
      return newSharedConfig;
    });

    on("config/updateSelectedModel", async (msg) => {
      const newSelectedModels = this.globalContext.updateSelectedModel(
        msg.data.profileId,
        msg.data.role,
        msg.data.title,
      );
      await this.configHandler.reloadConfig(
        "Selected model update (config/updateSelectedModel message)",
      );
      return newSelectedModels;
    });

    on("mcp/reloadServer", async (msg) => {
      await MCPManagerSingleton.getInstance().refreshConnection(msg.data.id);
    });
    on("mcp/setServerEnabled", async (msg) => {
      const { id, enabled } = msg.data;
      await MCPManagerSingleton.getInstance().setEnabled(id, enabled);
    });
    on("mcp/ensureConnections", async () => {
      const changed =
        await MCPManagerSingleton.getInstance().ensureConnections();
      if (changed) {
        // Reload config so the freshly connected servers' tools are included
        // in the browser-serialized config (config.tools) before the GUI
        // builds the request.
        await this.configHandler.reloadConfig(
          "MCP connections ensured before message",
        );
      }
      return changed;
    });
    on("mcp/getPrompt", async (msg) => {
      const { serverName, promptName, args } = msg.data;
      const prompt = await MCPManagerSingleton.getInstance().getPrompt(
        serverName,
        promptName,
        args,
      );
      const stringifiedPrompt = stringifyMcpPrompt(prompt);
      return {
        prompt: stringifiedPrompt,
        description: prompt.description,
      };
    });
    on("mcp/startAuthentication", async (msg) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      MCPManagerSingleton.getInstance().setStatus(
        msg.data.serverId,
        "authenticating",
      );
      const status = await performAuth(
        msg.data.serverId,
        msg.data.serverUrl,
        this.ide,
      );
      if (status === "AUTHORIZED") {
        await MCPManagerSingleton.getInstance().refreshConnection(
          msg.data.serverId,
        );
      }
    });
    on("mcp/removeAuthentication", async (msg) => {
      removeMCPAuth(msg.data.serverUrl, this.ide);
      await MCPManagerSingleton.getInstance().refreshConnection(
        msg.data.serverId,
      );
    });

    // Context providers
    on("context/addDocs", async (msg) => {
      void this.docsService.indexAndAdd(msg.data);
    });

    on("context/removeDocs", async (msg) => {
      await this.docsService.delete(msg.data.startUrl);
    });

    on("context/indexDocs", async (msg) => {
      await this.docsService.syncDocsWithPrompt(msg.data.reIndex);
    });

    on("context/loadSubmenuItems", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        return [];
      }

      try {
        const items = await config.contextProviders
          ?.find((provider) => provider.description.title === msg.data.title)
          ?.loadSubmenuItems({
            config,
            ide: this.ide,
            fetch: (url, init) =>
              fetchwithRequestOptions(url, init, config.requestOptions),
          });
        return items || [];
      } catch (e) {
        Logger.error(e);
        return [];
      }
    });

    on("context/getContextItems", this.getContextItems.bind(this));

    on("context/getSymbolsForFiles", async (msg) => {
      const { uris } = msg.data;
      return await getSymbolsForManyFiles(uris, this.ide);
    });

    on("config/getSerializedProfileInfo", async (msg) => {
      return {
        result: await this.configHandler.getSerializedConfig(),
        profileId:
          this.configHandler.currentProfile?.profileDescription.id ?? null,
        profiles: this.configHandler.profileDescriptions,
      };
    });

    on("llm/streamChat", (msg) => {
      const abortController = this.addMessageAbortController(msg.messageId);
      return llmStreamChat(
        this.configHandler,
        abortController,
        msg,
        this.ide,
        this.messenger,
        // 方案.md §7.5.4: the stream's model comes from the request's identity, resolved by the same
        // rule as `llm/compileChat` — never from `selectedModelByRole.chat`.
        { resolveChatModel: resolveRequestChatModel },
      );
    });

    on("llm/complete", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      const model = config?.selectedModelByRole.chat;
      if (!model) {
        throw new Error("No chat model selected");
      }
      const abortController = this.addMessageAbortController(msg.messageId);

      const completion = await model.complete(
        msg.data.prompt,
        abortController.signal,
        msg.data.completionOptions,
      );
      return completion;
    });
    on("llm/listModels", this.handleListModels.bind(this));

    on("llm/compileChat", async (msg) => {
      const { messages, options, protectedMessageIndexes, modelRef, title } =
        msg.data;
      // 方案.md §7.5.4: compile with the **request's** identity. Reading
      // `selectedModelByRole.chat` here (the profile default, possibly another tab's model) made the
      // token budget and prune decision describe a different model than the one that answered.
      // A request without a ref is the old title-only protocol, resolved the same way as the stream
      // resolves it, so both steps of one send still land on the same model.
      const model = await resolveRequestChatModel({ modelRef, title });

      return model.compileChatMessages(
        messages,
        options,
        protectedMessageIndexes,
      );
    });

    // Provide messenger to utils so they can interact with GUI + state
    TTS.messenger = this.messenger;
    ChatDescriber.messenger = this.messenger;

    on("tts/kill", async () => {
      void TTS.kill();
    });

    on("chatDescriber/describe", async (msg) => {
      const { config } = await this.configHandler.loadConfig();

      // 方案.md §七.10: resolve the *target session's* model from the request.
      //
      // Deliberately no fallback to `selectedModelByRole.chat`: that is the
      // profile-level (global) selection, and it may belong to a different tab.
      // Falling back to it is exactly the cross-session leak this contract
      // removes — the GUI already sends its own resolved model title, and it
      // only calls this at all when it resolved one, so a miss here means the
      // request is unsatisfiable. Failing lets the GUI's existing title
      // fallback take over instead of describing with the wrong model.
      //
      // Matching uses `title ?? model` because that is the exact projection
      // `llmToSerializedModelDescription` applies (`core/config/load.ts`), and
      // the GUI only ever sees the serialized titles. `ILLM.title` itself is
      // optional, so comparing `model.title` alone would never match a
      // title-less model.
      const targetModel = config?.modelsByRole.chat.find(
        (model) => (model.title ?? model.model) === msg.data.modelTitle,
      );

      if (!targetModel) {
        throw new Error(
          `Chat describer model not found for session ${msg.data.sessionId}: ${msg.data.modelTitle}`,
        );
      }

      return await ChatDescriber.describe(
        targetModel,
        {},
        msg.data.text,
        msg.data.messages,
      );
    });

    on("conversation/compact", async (msg) => {
      const currentModel = (await this.configHandler.loadConfig()).config
        ?.selectedModelByRole.chat;

      if (!currentModel) {
        throw new Error("No chat model selected");
      }

      try {
        const result = await compactConversation({
          sessionId: msg.data.sessionId,
          index: msg.data.index,
          historyManager,
          currentModel,
        });
        return result;
      } catch (error) {
        Logger.error(`Error compacting conversation: ${error}`);
        throw error;
      }
    });

    on("conversation/uncompact", async (msg) => {
      try {
        const session = historyManager.load(msg.data.sessionId);
        const firstUserItem = session.history.find(
          (item) => item.message.role === "user",
        );
        if (!firstUserItem) {
          return;
        }
        const modelRef = msg.data.modelRef ?? session.chatModelRef ?? undefined;
        const title = msg.data.title ?? session.chatModelTitle ?? undefined;
        const currentModel =
          modelRef || title
            ? await resolveRequestChatModel({ modelRef, title })
            : (await this.configHandler.loadConfig()).config
                ?.selectedModelByRole.chat;
        if (!currentModel) {
          return;
        }
        await currentModel.chat(
          [
            firstUserItem.message,
            {
              role: "user",
              content: "[VE_UNCOMPACT_SESSION]",
            },
          ],
          new AbortController().signal,
          {},
        );
      } catch (error) {
        Logger.error(`Error notifying uncompact conversation: ${error}`);
      }
    });

    on("conversation/fork", async (msg) => {
      try {
        return forkConversation({
          sessionId: msg.data.sessionId,
          index: msg.data.index,
          targetMessageId: msg.data.targetMessageId,
          historyManager,
        });
      } catch (error) {
        Logger.error(`Error forking conversation: ${error}`);
        throw error;
      }
    });

    // Autocomplete
    on("autocomplete/complete", async (msg) => {
      const outcome =
        await this.completionProvider.provideInlineCompletionItems(
          msg.data,
          undefined,
        );
      return outcome ? [outcome.completion] : [];
    });
    on("autocomplete/accept", async (msg) => {
      this.completionProvider.accept(msg.data.completionId);
    });
    on("autocomplete/cancel", async (msg) => {
      this.completionProvider.cancel();
    });

    // Next Edit
    on("nextEdit/predict", async (msg) => {
      const outcome = await this.nextEditProvider.provideInlineCompletionItems(
        msg.data.input,
        undefined,
        {
          withChain: msg.data.options?.withChain ?? false,
          usingFullFileDiff: msg.data.options?.usingFullFileDiff ?? true,
        },
      );
      return outcome;
      // ? [outcome.completion, outcome.originalEditableRange]
    });
    on("nextEdit/accept", async (msg) => {
      console.log("nextEdit/accept");
      this.nextEditProvider.accept(msg.data.completionId);
    });
    on("nextEdit/reject", async (msg) => {
      console.log("nextEdit/reject");
      this.nextEditProvider.reject(msg.data.completionId);
    });
    on("nextEdit/startChain", async (msg) => {
      console.log("nextEdit/startChain");
      NextEditProvider.getInstance().startChain();
      return;
    });

    on("nextEdit/deleteChain", async (msg) => {
      console.log("nextEdit/deleteChain");
      await NextEditProvider.getInstance().deleteChain();
      return;
    });

    on("nextEdit/isChainAlive", async (msg) => {
      console.log("nextEdit/isChainAlive");
      return NextEditProvider.getInstance().chainExists();
    });

    on("nextEdit/queue/getProcessedCount", async (msg) => {
      console.log("nextEdit/queue/getProcessedCount");
      const queue = PrefetchQueue.getInstance();
      console.log(queue.processedCount);
      return queue.processedCount;
    });

    on("nextEdit/queue/dequeueProcessed", async (msg) => {
      console.log("nextEdit/queue/dequeueProcessed");
      const queue = PrefetchQueue.getInstance();
      return queue.dequeueProcessed() || null;
    });

    // NOTE: This is not used unless prefetch is used.
    // At this point this is not used because I opted to rely on the model to return multiple diffs than to use prefetching.
    on("nextEdit/queue/processOne", async (msg) => {
      console.log("nextEdit/queue/processOne");
      const { ctx, recentlyVisitedRanges, recentlyEditedRanges } = msg.data;
      const queue = PrefetchQueue.getInstance();

      await queue.process({
        ...ctx,
        recentlyVisitedRanges,
        recentlyEditedRanges,
      });
      return;
    });

    on("nextEdit/queue/clear", async (msg) => {
      console.log("nextEdit/queue/clear");
      const queue = PrefetchQueue.getInstance();
      queue.clear();
      return;
    });

    on("nextEdit/queue/abort", async (msg) => {
      console.log("nextEdit/queue/abort");
      const queue = PrefetchQueue.getInstance();
      queue.abort();
      return;
    });

    on("streamDiffLines", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        throw new Error("Failed to load config");
      }

      const { data } = msg;

      // Title can be an edit, chat, or apply model
      // Fall back to chat
      const llm =
        config.modelsByRole.edit.find((m) => m.title === data.modelTitle) ??
        config.modelsByRole.apply.find((m) => m.title === data.modelTitle) ??
        config.modelsByRole.chat.find((m) => m.title === data.modelTitle) ??
        config.selectedModelByRole.chat;

      if (!llm) {
        throw new Error("No model selected");
      }

      const abortManager = ApplyAbortManager.getInstance();
      const abortController = abortManager.get(
        data.fileUri ?? "current-file-stream",
      ); // not super important since currently cancelling apply will cancel all streams it's one file at a time

      return streamDiffLines(
        data,
        llm,
        abortController,
        undefined,
        data.includeRulesInSystemMessage ? config.rules : undefined,
      );
    });

    on("getDiffLines", (msg) => {
      return myersDiff(msg.data.oldContent, msg.data.newContent);
    });

    on("cancelApply", async (msg) => {
      const abortManager = ApplyAbortManager.getInstance();
      abortManager.clear(); // for now abort all streams
    });

    on("onboarding/complete", this.handleCompleteOnboarding.bind(this));

    on("addAutocompleteModel", this.handleAddAutocompleteModel.bind(this));

    on("stats/getTokensPerDay", async (msg) => {
      const rows = await DevDataSqliteDb.getTokensPerDay();
      return rows;
    });
    on("stats/getTokensPerModel", async (msg) => {
      const rows = await DevDataSqliteDb.getTokensPerModel();
      return rows;
    });

    on("index/forceReIndex", async ({ data }) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config || config.disableIndexing) {
        return; // TODO silent in case of commands?
      }
      walkDirCache.invalidate();
      if (data?.shouldClearIndexes) {
        await this.codeBaseIndexer.clearIndexes();
      }
      const dirs = data?.dirs ?? (await this.ide.getWorkspaceDirs());
      await this.codeBaseIndexer.refreshCodebaseIndex(dirs);
    });
    on("index/setPaused", (msg) => {
      this.globalContext.update("indexingPaused", msg.data);
      // Update using the new setter instead of token
      this.codeBaseIndexer.paused = msg.data;
    });
    on("index/indexingProgressBarInitialized", async (msg) => {
      // Triggered when progress bar is initialized.
      // If a non-default state has been stored, update the indexing display to that state
      const currentState = this.codeBaseIndexer.currentIndexingState;

      if (currentState.status !== "loading") {
        void this.messenger.request("indexProgress", currentState);
      }
    });

    // File changes - TODO - remove remaining logic for these from IDEs where possible
    on("files/changed", this.handleFilesChanged.bind(this));
    const refreshIfNotIgnored = async (uris: string[]) => {
      const toRefresh: string[] = [];
      for (const uri of uris) {
        const ignore = await shouldIgnore(uri, this.ide);
        if (!ignore) {
          toRefresh.push(uri);
        }
      }
      if (toRefresh.length > 0) {
        this.messenger.send("refreshSubmenuItems", {
          providers: ["file"],
        });
        const { config } = await this.configHandler.loadConfig();
        if (config && !config.disableIndexing) {
          await this.codeBaseIndexer.refreshCodebaseIndexFiles(toRefresh);
        }
      }
    };

    on("files/created", async ({ data }) => {
      if (!data?.uris?.length) {
        return;
      }

      walkDirCache.invalidate();
      void refreshIfNotIgnored(data.uris);

      const colocatedRulesUris = data.uris.filter(isColocatedRulesFile);
      const nonColocatedRuleUris = data.uris.filter(
        (uri) => !isColocatedRulesFile(uri),
      );
      if (colocatedRulesUris) {
        const rulesCache = CodebaseRulesCache.getInstance();
        void Promise.all(
          colocatedRulesUris.map((uri) => rulesCache.update(this.ide, uri)),
        ).then(() => {
          void this.configHandler.reloadConfig("Codebase rule file created");
        });
      }

      // If it's a local config being created, we want to reload all configs so it shows up in the list
      if (nonColocatedRuleUris.some(isContinueAgentConfigFile)) {
        await this.configHandler.refreshAll("Local config file created");
      } else if (nonColocatedRuleUris.some(isContinueConfigRelatedUri)) {
        await this.configHandler.reloadConfig(
          ".continue config-related file created",
        );
      }
    });

    on("files/deleted", async ({ data }) => {
      if (!data?.uris?.length) {
        return;
      }

      walkDirCache.invalidate();
      void refreshIfNotIgnored(data.uris);

      const colocatedRulesUris = data.uris.filter(isColocatedRulesFile);
      const nonColocatedRuleUris = data.uris.filter(
        (uri) => !isColocatedRulesFile(uri),
      );

      if (colocatedRulesUris) {
        const rulesCache = CodebaseRulesCache.getInstance();
        void Promise.all(
          colocatedRulesUris.map((uri) => rulesCache.remove(uri)),
        ).then(() => {
          void this.configHandler.reloadConfig("Codebase rule file deleted");
        });
      }

      // If it's a local config being deleted, we want to reload all configs so it disappears from the list
      if (nonColocatedRuleUris.some(isContinueAgentConfigFile)) {
        await this.configHandler.refreshAll("Local config file deleted");
      } else if (nonColocatedRuleUris.some(isContinueConfigRelatedUri)) {
        await this.configHandler.reloadConfig(
          ".continue config-related file deleted",
        );
      }
    });

    on("files/closed", async ({ data }) => {
      console.debug("deleteChain called from files/closed");
      await NextEditProvider.getInstance().deleteChain();

      try {
        const fileUris = await this.ide.getOpenFiles();
        if (fileUris) {
          const filepaths = fileUris.map((uri) => uri.toString());

          if (!prevFilepaths.filepaths.length) {
            prevFilepaths.filepaths = filepaths;
          }

          // If there is a removal, including if the number of tabs is the same (which can happen with temp tabs)
          if (filepaths.length <= prevFilepaths.filepaths.length) {
            // Remove files from cache that are no longer open (i.e. in the cache but not in the list of opened tabs)
            for (const [key, _] of openedFilesLruCache.entriesDescending()) {
              if (!filepaths.includes(key)) {
                openedFilesLruCache.delete(key);
              }
            }
          }
          prevFilepaths.filepaths = filepaths;
        }
      } catch (e) {
        Logger.error(
          `didChangeVisibleTextEditors: failed to update openedFilesLruCache`,
        );
      }

      if (data.uris) {
        this.messenger.send("didCloseFiles", {
          uris: data.uris,
        });
      }
    });

    on("files/opened", async ({ data: { uris } }) => {
      if (uris) {
        for (const filepath of uris) {
          try {
            const ignore = await shouldIgnore(filepath, this.ide);
            if (!ignore) {
              // Set the active file as most recently used (need to force recency update by deleting and re-adding)
              if (openedFilesLruCache.has(filepath)) {
                openedFilesLruCache.delete(filepath);
              }
              openedFilesLruCache.set(filepath, filepath);
            }
          } catch (e) {
            Logger.error(
              `files/opened: failed to update openedFiles cache for ${filepath}`,
            );
          }
        }
      }
    });

    on("files/smallEdit", async ({ data }) => {
      const EDIT_AGGREGATION_OPTIONS = {
        deltaT: 1.0,
        deltaL: 5,
        maxEdits: 500,
        maxDuration: 120.0,
        contextSize: 5,
      };

      EditAggregator.getInstance(
        EDIT_AGGREGATION_OPTIONS,
        (
          beforeAfterdiff: BeforeAfterDiff,
          cursorPosBeforeEdit: Position,
          cursorPosAfterPrevEdit: Position,
        ) => {
          void processSmallEdit(
            beforeAfterdiff,
            cursorPosBeforeEdit,
            cursorPosAfterPrevEdit,
            data.configHandler,
            data.getDefsFromLspFunction,
            this.ide,
          );
        },
      );

      const workspaceDir =
        data.actions.length > 0 ? data.actions[0].workspaceDir : undefined;

      // Store the latest context data
      const instance = EditAggregator.getInstance();
      (instance as any).latestContextData = {
        configHandler: data.configHandler,
        getDefsFromLspFunction: data.getDefsFromLspFunction,
        recentlyEditedRanges: data.recentlyEditedRanges,
        recentlyVisitedRanges: data.recentlyVisitedRanges,
        workspaceDir: workspaceDir,
      };

      // queueMicrotask prevents blocking the UI thread during typing
      queueMicrotask(() => {
        void EditAggregator.getInstance().processEdits(data.actions);
      });
    });

    // Docs, etc. indexing
    on("indexing/reindex", async (msg) => {
      if (msg.data.type === "docs") {
        void this.docsService.reindexDoc(msg.data.id);
      }
    });
    on("indexing/abort", async (msg) => {
      if (msg.data.type === "docs") {
        this.docsService.abort(msg.data.id);
      }
    });
    on("indexing/setPaused", async (msg) => {
      if (msg.data.type === "docs") {
      }
    });
    on("docs/initStatuses", async (msg) => {
      void this.docsService.initStatuses();
    });
    on("docs/getDetails", async (msg) => {
      return await this.docsService.getDetails(msg.data.startUrl);
    });
    on("docs/getIndexedPages", async (msg) => {
      const pages = await this.docsService.getIndexedPages(msg.data.startUrl);
      return Array.from(pages);
    });

    on("didChangeSelectedProfile", async (msg) => {
      if (msg.data.id) {
        await this.configHandler.setSelectedProfileId(msg.data.id);
      }
    });

    on("auth/getAuthUrl", async (_msg) => {
      return { url: "" };
    });

    on("tools/call", async ({ data: { toolCall } }) =>
      this.handleToolCall(toolCall),
    );

    on(
      "tools/evaluatePolicy",
      async ({ data: { toolName, basePolicy, parsedArgs, processedArgs } }) => {
        const { config } = await this.configHandler.loadConfig();
        if (!config) {
          throw new Error("Config not loaded");
        }

        const tool = config.tools.find((t) => t.function.name === toolName);
        if (!tool) {
          return { policy: basePolicy };
        }

        // Extract display value for specific tools
        let displayValue: string | undefined;
        if (toolName === "runTerminalCommand" && parsedArgs.command) {
          displayValue = parsedArgs.command as string;
        }

        if (tool.evaluateToolCallPolicy) {
          const evaluatedPolicy = tool.evaluateToolCallPolicy(
            basePolicy,
            parsedArgs,
            processedArgs,
          );
          return { policy: evaluatedPolicy, displayValue };
        }
        return { policy: basePolicy, displayValue };
      },
    );

    on("tools/preprocessArgs", async ({ data: { toolName, args } }) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        throw new Error("Config not loaded");
      }

      const tool = config?.tools.find((t) => t.function.name === toolName);
      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      try {
        const preprocessedArgs = await tool.preprocessArgs?.(args, {
          ide: this.ide,
        });
        return {
          preprocessedArgs,
        };
      } catch (e) {
        let errorReason =
          e instanceof ContinueError ? e.reason : ContinueErrorReason.Unknown;
        let errorMessage =
          e instanceof Error
            ? e.message
            : `Error preprocessing tool call args for ${toolName}\n${JSON.stringify(args)}`;
        return {
          preprocessedArgs: undefined,
          errorReason,
          errorMessage,
        };
      }
    });

    on("isItemTooBig", async ({ data: { item } }) => {
      return this.isItemTooBig(item);
    });

    // Process state handlers
    on("process/markAsBackgrounded", async ({ data: { toolCallId } }) => {
      markProcessAsBackgrounded(toolCallId);
    });

    on(
      "process/isBackgrounded",
      async ({ data: { toolCallId }, messageId }) => {
        const isBackgrounded = isProcessBackgrounded(toolCallId);
        return isBackgrounded; // Return true to indicate the message was handled successfully
      },
    );

    on("process/killTerminalProcess", async ({ data: { toolCallId } }) => {
      await killTerminalProcess(toolCallId);
    });

    on("models/fetch", async (msg) => {
      try {
        return await fetchModels(
          msg.data.provider,
          msg.data.apiKey,
          msg.data.apiBase,
        );
      } catch (error: any) {
        void this.ide.showToast("error", error.message);
        return [];
      }
    });
  }

  private async handleToolCall(toolCall: ToolCall) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      throw new Error("Config not loaded");
    }

    const tool = config.tools.find(
      (t) => t.function.name === toolCall.function.name,
    );

    if (!tool) {
      throw new Error(`Tool ${toolCall.function.name} not found`);
    }

    if (!config.selectedModelByRole.chat) {
      throw new Error("No chat model selected");
    }

    // Define a callback for streaming output updates
    const onPartialOutput = (params: {
      toolCallId: string;
      contextItems: ContextItem[];
    }) => {
      this.messenger.send("toolCallPartialOutput", params);
    };

    const result = await callTool(tool, toolCall, {
      config,
      ide: this.ide,
      llm: config.selectedModelByRole.chat,
      fetch: (url, init) =>
        fetchwithRequestOptions(url, init, config.requestOptions),
      tool,
      toolCallId: toolCall.id,
      onPartialOutput,
      codeBaseIndexer: this.codeBaseIndexer,
    });

    return result;
  }

  private async isItemTooBig(item: ContextItemWithId) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return false;
    }

    const llm = config?.selectedModelByRole.chat;
    if (!llm) {
      throw new Error("No chat model selected");
    }

    const tokens = countTokens(item.content, llm.model);

    if (tokens > llm.contextLength - llm.completionOptions!.maxTokens!) {
      return true;
    }

    return false;
  }

  private handleAddAutocompleteModel(
    msg: Message<{
      model: ModelDescription;
    }>,
  ) {
    const model = msg.data.model;
    editConfigFile(
      (config) => {
        return {
          ...config,
          tabAutocompleteModel: model,
        };
      },
      (config) => ({
        ...config,
        models: [
          ...(config.models ?? []),
          {
            name: model.title,
            provider: model.provider,
            model: model.model,
            apiKey: model.apiKey,
            roles: ["autocomplete"],
            apiBase: model.apiBase,
          },
        ],
      }),
    );
    void this.configHandler.reloadConfig("Autocomplete model added");
  }

  private async handleFilesChanged({
    data,
  }: Message<{
    uris?: string[];
  }>): Promise<void> {
    if (data?.uris?.length) {
      const diffCache = GitDiffCache.getInstance(getDiffFn(this.ide));
      diffCache.invalidate();
      walkDirCache.invalidate(); // safe approach for now - TODO - only invalidate on relevant changes
      const currentProfileUri =
        this.configHandler.currentProfile?.profileDescription.uri ?? "";
      for (const uri of data.uris) {
        if (URI.equal(uri, currentProfileUri)) {
          // Trigger a toast notification to provide UI feedback that config has been updated
          const showToast =
            this.globalContext.get("showConfigUpdateToast") ?? true;
          if (showToast) {
            const selection = await this.ide.showToast(
              "info",
              "Config updated",
              "Don't show again",
            );
            if (selection === "Don't show again") {
              this.globalContext.update("showConfigUpdateToast", false);
            }
          }
          await this.configHandler.reloadConfig(
            "Current profile config file updated",
          );
          continue;
        }
        if (isColocatedRulesFile(uri)) {
          try {
            const codebaseRulesCache = CodebaseRulesCache.getInstance();
            void codebaseRulesCache.update(this.ide, uri).then(() => {
              void this.configHandler.reloadConfig("Codebase rule update");
            });
          } catch (e) {
            Logger.error(`Failed to update codebase rule: ${e}`);
          }
        } else if (isContinueConfigRelatedUri(uri)) {
          await this.configHandler.reloadConfig(
            "Local config-related file updated",
          );
        } else if (
          uri.endsWith(".continueignore") ||
          uri.endsWith(".gitignore")
        ) {
          // Reindex the workspaces
          this.invoke("index/forceReIndex", {
            shouldClearIndexes: true,
          });
        } else {
          const { config } = await this.configHandler.loadConfig();
          if (config && !config.disableIndexing) {
            // Reindex the file
            const ignore = await shouldIgnore(uri, this.ide);
            if (!ignore) {
              await this.codeBaseIndexer.refreshCodebaseIndexFiles([uri]);
            }
          }
        }
      }
    }
  }

  private async handleListModels(msg: Message<{ title: string }>) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const model =
      config.modelsByRole.chat.find(
        (model) => model.title === msg.data.title,
      ) ??
      config.modelsByRole.chat.find((model) =>
        model.title?.startsWith(msg.data.title),
      );

    try {
      if (model) {
        return await model.listModels();
      } else {
        if (msg.data.title === "Ollama") {
          const models = await new Ollama({ model: "" }).listModels();
          return models;
        } else if (msg.data.title === "Lemonade") {
          const models = await new Lemonade({ model: "" }).listModels();
          return models;
        } else {
          return undefined;
        }
      }
    } catch (e) {
      console.debug(`Error listing Ollama models: ${e}`);
      return undefined;
    }
  }

  private async handleCompleteOnboarding(
    msg: Message<CompleteOnboardingPayload>,
  ) {
    const { mode, provider, apiKey } = msg.data;

    let editConfigYamlCallback: (config: ConfigYaml) => ConfigYaml;

    switch (mode) {
      case OnboardingModes.LOCAL:
        editConfigYamlCallback = setupLocalConfig;
        break;

      case OnboardingModes.API_KEY:
        if (provider && apiKey) {
          editConfigYamlCallback = (config: ConfigYaml) =>
            setupProviderConfig(config, provider, apiKey);
        } else {
          editConfigYamlCallback = setupQuickstartConfig;
        }
        break;

      default:
        Logger.error(`Invalid mode: ${mode}`);
        editConfigYamlCallback = (config) => config;
    }

    editConfigFile((c) => c, editConfigYamlCallback);

    void this.configHandler.reloadConfig("Onboarding completed");
  }

  private getContextItems = async (
    msg: Message<{
      name: string;
      query: string;
      fullInput: string;
      selectedCode: RangeInFile[];
      isInAgentMode: boolean;
    }>,
  ) => {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const { name, query, fullInput, selectedCode } = msg.data;

    const llm = (await this.configHandler.loadConfig()).config
      ?.selectedModelByRole.chat;

    if (!llm) {
      throw new Error("No chat model selected");
    }

    const provider = config.contextProviders?.find(
      (provider) => provider.description.title === name,
    );
    if (!provider) {
      return [];
    }

    try {
      const items = await provider.getContextItems(query, {
        config,
        llm,
        embeddingsProvider: config.selectedModelByRole.embed,
        fullInput,
        ide: this.ide,
        selectedCode,
        reranker: config.selectedModelByRole.rerank,
        fetch: (url, init) =>
          // Important note: context providers fetch uses global request options not LLM request options
          // Because LLM calls are handled separately
          fetchwithRequestOptions(url, init, config.requestOptions),
        isInAgentMode: msg.data.isInAgentMode,
      });

      return items.map((item) => {
        const id: ContextItemId = {
          providerTitle: provider.description.title,
          itemId: uuidv4(),
        };

        return { ...item, id };
      });
    } catch (e) {
      let knownError = false;

      if (e instanceof Error) {
        // After removing transformers JS embeddings provider from jetbrains
        // Should no longer see this error
        // if (e.message.toLowerCase().includes("embeddings provider")) {
        //   knownError = true;
        //   const toastOption = "See Docs";
        //   void this.ide
        //     .showToast(
        //       "error",
        //       `Set up an embeddings model to use @${name}`,
        //       toastOption,
        //     )
        //     .then((userSelection) => {
        //       if (userSelection === toastOption) {
        //         void this.ide.openUrl(
        //           "https://docs.continue.dev/customize/model-roles/embeddings",
        //         );
        //       }
        //     });
        // }
      }
      if (!knownError) {
        void this.ide.showToast(
          "error",
          `Error getting context items from ${name}: ${e}`,
        );
      }
      return [];
    }
  };
}
