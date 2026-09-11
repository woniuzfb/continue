import * as fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { Core } from "./core.js";
import type { ChatMessage, ILLM, Session } from "./index.js";
import { measureChatMessagesNoPrune } from "./llm/countTokens.js";
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  type FullConversationMeasurementRequest,
} from "./util/fullConversationMetrics.js";
import historyManager from "./util/history.js";
import { getSessionFilePath } from "./util/paths.js";

/**
 * Stage 2D-2：`history/measureConversation` 的**只读**重算。
 *
 * 关键性质：history 来自**磁盘完整会话**（不是 GUI 窗口）、不修改磁盘、
 * 失败可见（模型解析不到 / schema 不一致 ⇒ 抛出，而不是拿错输入算出"新鲜"值）。
 *
 * 用与 `core.core.chatDescriber.vitest.ts` 相同的 harness：走真实的
 * `registerMessageHandlers` 注册路径，只替换注册与该 handler 需要的依赖。
 */

type Handler = (msg: any) => any;

function harness(config: unknown) {
  const handlers = new Map<string, Handler>();
  const messenger: any = {
    on(type: string, handler: Handler) {
      handlers.set(type, handler);
    },
    onError() {},
    send() {
      return "";
    },
    async request() {
      return {};
    },
  };
  const core: any = Object.assign(Object.create(Core.prototype), {
    messenger,
    ide: {},
    getContextItems: async () => [],
    configHandler: {
      async loadConfig() {
        return { config };
      },
    },
  });
  (Core.prototype as any).registerMessageHandlers.call(
    core,
    Promise.resolve({}),
  );
  return {
    async measure(data: unknown) {
      const handler = handlers.get("history/measureConversation");
      if (!handler) {
        throw new Error("history/measureConversation was not registered");
      }
      return await handler({
        messageType: "history/measureConversation",
        data,
      });
    },
    async save(data: unknown) {
      const handler = handlers.get("history/save");
      if (!handler) {
        throw new Error("history/save was not registered");
      }
      return await handler({ messageType: "history/save", data });
    },
  };
}

/** A stand-in chat model exposing the exact inputs the measurement reads. */
function chatModel(title: string): ILLM {
  return {
    title,
    model: title,
    contextLength: 128000,
    supportsImages: () => true,
    excludeToolOutputsFromTokenCount: false,
    excludeToolOutputsFromTokenCountMinTokens: 6000,
    measureChatMessagesNoPrune: (
      messages: ChatMessage[],
      options: { model?: string; maxTokens?: number; tools?: unknown[] },
    ) =>
      measureChatMessagesNoPrune({
        modelName: options?.model ?? title,
        msgs: messages,
        knownContextLength: 128000,
        maxTokens: options?.maxTokens ?? 2000,
        supportsImages: true,
        tools: options?.tools as any,
        excludeToolOutputsFromTokenCount: false,
      }),
  } as unknown as ILLM;
}

function measurement(
  overrides: Partial<FullConversationMeasurementRequest> = {},
): FullConversationMeasurementRequest {
  return {
    modelTitle: "gpt-4o",
    mode: "chat",
    systemMessage: "SYSTEM",
    rules: [],
    ruleSettings: {},
    tools: [],
    reasoning: false,
    completionOptions: { model: "gpt-4o", maxTokens: 2000 },
    conversationRevision: 5,
    constructionIdentity: "identity-5",
    schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
    ...overrides,
  };
}

function historyItems(n: number): Session["history"] {
  const items: Session["history"] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      message: { role: "user", content: `question ${i}`, id: `u${i}` },
      contextItems: [],
    } as Session["history"][number]);
    items.push({
      message: { role: "assistant", content: `answer ${i}`, id: `a${i}` },
      contextItems: [],
    } as Session["history"][number]);
  }
  return items;
}

function seedSession(sessionId: string, items: Session["history"]): void {
  fs.writeFileSync(
    getSessionFilePath(sessionId),
    JSON.stringify({
      sessionId,
      title: "Chat 1",
      workspaceDirectory: "ws",
      history: items,
      mode: "chat",
    } satisfies Session),
  );
}

describe("history/measureConversation", () => {
  it("measures the full disk history and does not touch the file", async () => {
    const sessionId = uuidv4();
    seedSession(sessionId, historyItems(4));
    const before = fs.readFileSync(getSessionFilePath(sessionId), "utf8");
    const core = harness({ modelsByRole: { chat: [chatModel("gpt-4o")] } });

    const result = await core.measure({
      sessionId,
      measurement: measurement(),
    });

    // The measured conversation is system + every message on disk.
    const independent = measureChatMessagesNoPrune({
      modelName: "gpt-4o",
      msgs: [
        { role: "system", content: "SYSTEM" } as ChatMessage,
        ...historyItems(4).map((item) => item.message),
      ],
      knownContextLength: 128000,
      maxTokens: 2000,
      supportsImages: true,
    });
    expect(result.metrics).toEqual(independent);
    expect(result.meta).toEqual({
      conversationRevision: 5,
      constructionIdentity: "identity-5",
      schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
    });
    // Read-only: byte-identical file, no metrics written.
    expect(fs.readFileSync(getSessionFilePath(sessionId), "utf8")).toBe(before);
    expect(JSON.parse(before).contextMetrics).toBeUndefined();
  });

  it("fails loudly when the model title cannot be resolved", async () => {
    const sessionId = uuidv4();
    seedSession(sessionId, historyItems(1));
    const core = harness({
      modelsByRole: { chat: [chatModel("other-model")] },
    });

    await expect(
      core.measure({ sessionId, measurement: measurement() }),
    ).rejects.toThrowError(/model not found for title "gpt-4o"/);
  });

  it("fails loudly on a schema mismatch", async () => {
    const sessionId = uuidv4();
    seedSession(sessionId, historyItems(1));
    const core = harness({ modelsByRole: { chat: [chatModel("gpt-4o")] } });

    await expect(
      core.measure({
        sessionId,
        measurement: measurement({ schemaVersion: 99 }),
      }),
    ).rejects.toThrowError(/unsupported measurement schema 99/);
  });

  it("matches a title-less model by its model string", async () => {
    const sessionId = uuidv4();
    seedSession(sessionId, historyItems(1));
    const titleLess = { ...chatModel("model-x"), title: undefined } as ILLM;
    const core = harness({ modelsByRole: { chat: [titleLess] } });

    const result = await core.measure({
      sessionId,
      measurement: measurement({ modelTitle: "model-x" }),
    });
    expect(result.metrics.inputTokens).toBeGreaterThan(0);
  });
});

describe("history/save measurement wiring", () => {
  it("skips the measurement but still saves when the model is missing", async () => {
    const sessionId = uuidv4();
    const core = harness({ modelsByRole: { chat: [] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await core.save({
      sessionId,
      title: "Chat 1",
      workspaceDirectory: "ws",
      history: historyItems(2),
      mode: "chat",
      fullConversationMeasurement: measurement(),
    });

    // The save happened; the metric did not — the GUI keeps its last-known value.
    expect(response.fullConversationMetrics).toBeUndefined();
    expect(
      JSON.parse(fs.readFileSync(getSessionFilePath(sessionId), "utf8"))
        .history,
    ).toHaveLength(4);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("measurement skipped: model not found"),
    );
    warn.mockRestore();
  });

  it("writes and returns the measurement for a resolvable model", async () => {
    const sessionId = uuidv4();
    const core = harness({ modelsByRole: { chat: [chatModel("gpt-4o")] } });

    const response = await core.save({
      sessionId,
      title: "Chat 1",
      workspaceDirectory: "ws",
      history: historyItems(2),
      mode: "chat",
      fullConversationMeasurement: measurement(),
    });

    expect(response.fullConversationMetrics?.meta.constructionIdentity).toBe(
      "identity-5",
    );
    const onDisk = JSON.parse(
      fs.readFileSync(getSessionFilePath(sessionId), "utf8"),
    );
    expect(onDisk.contextMetrics).toEqual(response.fullConversationMetrics);
    // ...and the response is what a subsequent plain save would preserve.
    const plain = await core.save({
      sessionId,
      title: "Chat 1",
      workspaceDirectory: "ws",
      history: historyItems(3),
      mode: "chat",
    });
    expect(plain.fullConversationMetrics).toBeUndefined();
    expect(
      JSON.parse(fs.readFileSync(getSessionFilePath(sessionId), "utf8"))
        .contextMetrics,
    ).toEqual(response.fullConversationMetrics);
  });
});
