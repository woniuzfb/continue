import * as fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Session } from "..";
import historyManager from "./history";
import {
  measureChatMessagesNoPrune,
  type ChatTokenMeasurement,
} from "../llm/countTokens";
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  type FullConversationMeasurementRequest,
  type FullConversationMetricsResult,
} from "./fullConversationMetrics";
import {
  measureFullConversation,
  measurementSchemaMatches,
} from "./fullConversationMeasurement";
import { getSessionFilePath } from "./paths";

/**
 * Stage 2D-1（方案.md §五.16.4 / §五.16.7）：`history/save` 在**保存锁内**用同一份
 * `finalHistory` 构造完整会话并 no-prune 计量，把 history 与 metrics 一次原子写盘，
 * 并把**同一个** Result 回传。
 *
 * 另外两条规则同样被固定：
 * - 未携带计量 ⇒ 只保存，磁盘上已有的 metrics 原样保留（载荷里的 `contextMetrics`
 *   不再被采信）；
 * - 写盘失败 ⇒ history 与 metrics 都不变。
 */

const MODEL = "gpt-4";

function measurement(
  overrides: Partial<FullConversationMeasurementRequest> = {},
): FullConversationMeasurementRequest {
  return {
    modelTitle: MODEL,
    mode: "chat",
    systemMessage: "SYSTEM",
    rules: [],
    ruleSettings: {},
    tools: [],
    reasoning: false,
    completionOptions: { model: MODEL, maxTokens: 2000 },
    conversationRevision: 7,
    constructionIdentity: "identity-7",
    schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
    ...overrides,
  };
}

/** 注入给 `measureFullConversation` 的计量实现：真实 no-prune 计量 + 记录入参。 */
function realMeasure(
  sink?: { messages: ChatMessage[] },
  budget: { knownContextLength: number; maxTokens: number } = {
    knownContextLength: 128000,
    maxTokens: 2000,
  },
) {
  return (messages: ChatMessage[]) => {
    if (sink) {
      sink.messages = messages;
    }
    return measureChatMessagesNoPrune({
      modelName: MODEL,
      msgs: messages,
      knownContextLength: budget.knownContextLength,
      maxTokens: budget.maxTokens,
      supportsImages: true,
    });
  };
}

function sessionWith(
  sessionId: string,
  history: Session["history"],
  overrides: Partial<Session> = {},
): Session {
  return {
    sessionId,
    title: "Chat 1",
    workspaceDirectory: "ws",
    history,
    ...overrides,
  };
}

function history(n = 3): Session["history"] {
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

function readRawSession(sessionId: string): Session {
  return JSON.parse(fs.readFileSync(getSessionFilePath(sessionId), "utf8"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("history/save with a full-conversation measurement", () => {
  it("writes the result atomically with the history and returns the same object", async () => {
    const sessionId = uuidv4();
    const request = measurement();

    const response = await historyManager.save(
      sessionWith(sessionId, history()),
      {
        measureFullConversation: (finalHistory) =>
          measureFullConversation({
            history: finalHistory,
            request,
            measure: realMeasure(),
          }),
      },
    );

    expect(response.fullConversationMetrics).toBeDefined();
    const onDisk = readRawSession(sessionId);
    // Same values in the response and on disk: the GUI accepts only what the save
    // actually wrote (no second measurement).
    expect(onDisk.contextMetrics).toEqual(response.fullConversationMetrics);
    expect(
      (onDisk.contextMetrics as FullConversationMetricsResult).meta,
    ).toEqual({
      conversationRevision: 7,
      constructionIdentity: "identity-7",
      schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
    });
    expect(onDisk.history).toHaveLength(6);
  });

  it("writes a JSON-safe Result when the output reservation consumes the window", async () => {
    // 方案.md §7.1.4: the anomaly case (no input budget) must still be persistable.
    // `JSON.stringify(Infinity)` is `null`, so an infinite percentage would make the
    // response and the file disagree — and the reader grades a Result with a null
    // percentage as `unavailable` (方案.md §五.16.5), i.e. the save would look failed
    // after a reload.
    const sessionId = uuidv4();
    const request = measurement({
      completionOptions: { model: MODEL, maxTokens: 5000 },
    });

    const response = await historyManager.save(
      sessionWith(sessionId, history()),
      {
        measureFullConversation: (finalHistory) =>
          measureFullConversation({
            history: finalHistory,
            request,
            measure: realMeasure(undefined, {
              knownContextLength: 1000,
              maxTokens: 5000,
            }),
          }),
      },
    );

    const result = response.fullConversationMetrics!;
    expect(result.metrics.availableTokens).toBeLessThanOrEqual(0);
    expect(result.metrics.exceedsContext).toBe(true);
    expect(Number.isFinite(result.metrics.contextPercentage)).toBe(true);
    // Byte-for-byte the same object comes back from the file.
    const onDisk = readRawSession(sessionId);
    expect(onDisk.contextMetrics).toEqual(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("refuses to persist a non-JSON-safe measurement", async () => {
    // 方案.md §7.1.4 write-boundary backstop: `JSON.stringify(Infinity)` is `null`, and
    // the reader must not guess a value back from a lossy `null`. A producer bug must
    // therefore degrade to "metrics unchanged", never to a corrupt file.
    const sessionId = uuidv4();
    const first = await historyManager.save(sessionWith(sessionId, history()), {
      measureFullConversation: (finalHistory) =>
        measureFullConversation({
          history: finalHistory,
          request: measurement(),
          measure: realMeasure(),
        }),
    });
    const goodMetrics = first.fullConversationMetrics!;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const second = await historyManager.save(
      sessionWith(sessionId, history(4)),
      {
        measureFullConversation: (finalHistory) =>
          measureFullConversation({
            history: finalHistory,
            request: measurement(),
            measure: () => ({
              inputTokens: 10,
              contextLength: 100,
              availableTokens: 0,
              contextPercentage: Number.POSITIVE_INFINITY,
              exceedsContext: true,
            }),
          }),
      },
    );

    // The save itself still succeeds and the new history is on disk…
    expect(readRawSession(sessionId).history).toHaveLength(8);
    // …but nothing was returned as "the metrics this save wrote", and the previous
    // value is preserved instead of being replaced by `null`.
    expect(second.fullConversationMetrics).toBeUndefined();
    expect(readRawSession(sessionId).contextMetrics).toEqual(goodMetrics);
  });

  it("measures the history it writes, not the runtime window", async () => {
    const sessionId = uuidv4();
    const full = history(4);

    const response = await historyManager.save(sessionWith(sessionId, full), {
      measureFullConversation: (finalHistory) =>
        measureFullConversation({
          history: finalHistory,
          request: measurement(),
          measure: realMeasure(),
        }),
    });

    const onDisk = readRawSession(sessionId);
    const independent = measureChatMessagesNoPrune({
      modelName: MODEL,
      msgs: [
        { role: "system", content: "SYSTEM" } as ChatMessage,
        ...onDisk.history.map((item) => item.message),
      ],
      knownContextLength: 128000,
      maxTokens: 2000,
      supportsImages: true,
    });
    expect(response.fullConversationMetrics?.metrics).toEqual(independent);
  });

  it("measures the persisted (slimmed) content, i.e. after the disk transforms", async () => {
    const sessionId = uuidv4();
    // A fat attached-file block in the LAST user message: `constructMessages` keeps
    // block bodies there (history messages get them stripped), so the saved
    // conversation really differs from the un-slimmed one.
    const fat: Session["history"] = [
      {
        message: { role: "assistant", content: "ok", id: "a0" },
        contextItems: [],
      } as Session["history"][number],
      {
        message: {
          role: "user",
          content:
            "Files attached:\n\n" +
            '<file_content path="a.ts">\n' +
            "const x = 1;\n".repeat(60) +
            "</file_content>\n",
          metadata: { attachments: [{ path: "a.ts" }] },
        },
        contextItems: [],
      } as Session["history"][number],
    ];
    expect(fat[1].message.content).toContain("const x = 1;");

    // What the measurement sees *at callback time*: the disk transforms have
    // already run, and they mutate the caller's items in place (pre-existing
    // `save` behaviour), so the runtime window and the file agree.
    let bodyAtMeasureTime: string | undefined;
    const response = await historyManager.save(sessionWith(sessionId, fat), {
      measureFullConversation: (finalHistory) => {
        bodyAtMeasureTime = String(finalHistory[1].message.content);
        return measureFullConversation({
          history: finalHistory,
          request: measurement(),
          measure: realMeasure(),
        });
      },
    });

    expect(bodyAtMeasureTime).not.toContain("const x = 1;");

    const onDisk = readRawSession(sessionId);
    expect(onDisk.history[1].message.content).not.toContain("const x = 1;");
    const fromDisk = measureChatMessagesNoPrune({
      modelName: MODEL,
      msgs: [
        { role: "system", content: "SYSTEM" } as ChatMessage,
        ...onDisk.history.map((item) => item.message),
      ],
      knownContextLength: 128000,
      maxTokens: 2000,
      supportsImages: true,
    });
    expect(response.fullConversationMetrics?.metrics).toEqual(fromDisk);
  });

  it("measures the merged history of a truncated save", async () => {
    const sessionId = uuidv4();
    // Seed a 6-item session on disk, then save a truncated window of its tail.
    await historyManager.save(sessionWith(sessionId, history(3)));
    const diskHistory = readRawSession(sessionId).history;

    const tail = diskHistory.slice(4);
    const seen: { messages: ChatMessage[] } = { messages: [] };
    const response = await historyManager.save(
      sessionWith(sessionId, tail, {
        historyTruncated: true,
        historyLoadedOffset: 4,
      }),
      {
        measureFullConversation: (finalHistory) =>
          measureFullConversation({
            history: finalHistory,
            request: measurement(),
            measure: realMeasure(seen),
          }),
      },
    );

    const onDisk = readRawSession(sessionId);
    expect(onDisk.history).toHaveLength(6);
    // The measurement saw the merged history (system + all six items), not the tail.
    expect(seen.messages[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(seen.messages).toHaveLength(7);
    expect(
      response.fullConversationMetrics?.metrics.inputTokens,
    ).toBeGreaterThan(0);
  });

  it("keeps the existing disk metrics when no measurement is carried", async () => {
    const sessionId = uuidv4();
    const measured = await historyManager.save(
      sessionWith(sessionId, history()),
      {
        measureFullConversation: (finalHistory) =>
          measureFullConversation({
            history: finalHistory,
            request: measurement(),
            measure: realMeasure(),
          }),
      },
    );
    const measuredResult = measured.fullConversationMetrics;

    // A plain save (checkpoint / retry / anything without a measurement) must not
    // touch the metrics — and must ignore a stale legacy-shaped payload field.
    const plain = await historyManager.save(
      sessionWith(sessionId, history(4), {
        contextMetrics: {
          didPrune: true,
          contextPercentage: 0.99,
          inputTokens: 1,
          contextLength: 2,
        },
      }),
    );

    expect(plain.fullConversationMetrics).toBeUndefined();
    const onDisk = readRawSession(sessionId);
    expect(onDisk.contextMetrics).toEqual(measuredResult);
    expect(onDisk.history).toHaveLength(8);
  });

  it("preserves a legacy disk snapshot too", async () => {
    const sessionId = uuidv4();
    const legacy = {
      didPrune: false,
      contextPercentage: 0.25,
      inputTokens: 25,
      contextLength: 100,
    };
    // Seed a "legacy" file by hand: an older save with no measurement.
    fs.writeFileSync(
      getSessionFilePath(sessionId),
      JSON.stringify(
        sessionWith(sessionId, history(2), { contextMetrics: legacy }),
      ),
    );

    await historyManager.save(sessionWith(sessionId, history(3)));

    expect(readRawSession(sessionId).contextMetrics).toEqual(legacy);
  });

  it("changes neither history nor metrics when the write fails", async () => {
    const sessionId = uuidv4();
    const before = await historyManager.save(
      sessionWith(sessionId, history()),
      {
        measureFullConversation: (finalHistory) =>
          measureFullConversation({
            history: finalHistory,
            request: measurement(),
            measure: realMeasure(),
          }),
      },
    );
    const diskBefore = fs.readFileSync(getSessionFilePath(sessionId), "utf8");

    // Freeze the clock so the temp path is predictable, then block it with a
    // directory: `writeFileSync` fails while the lock and the reads still work.
    const frozen = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(frozen);
    const tmpPath = `${getSessionFilePath(sessionId)}.tmp-${process.pid}-${frozen}`;
    fs.mkdirSync(tmpPath, { recursive: true });
    try {
      await expect(
        historyManager.save(sessionWith(sessionId, history(5)), {
          measureFullConversation: (finalHistory) =>
            measureFullConversation({
              history: finalHistory,
              request: measurement({
                constructionIdentity: "identity-should-not-land",
              }),
              measure: realMeasure(),
            }),
        }),
      ).rejects.toMatchObject({ code: "SESSION_SAVE_FAILED" });
    } finally {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }

    // Byte-identical: history and metrics both untouched.
    expect(fs.readFileSync(getSessionFilePath(sessionId), "utf8")).toBe(
      diskBefore,
    );
    expect(readRawSession(sessionId).contextMetrics).toEqual(
      before.fullConversationMetrics,
    );
  });

  it("does not land a measurement when the callback throws", async () => {
    const sessionId = uuidv4();
    await historyManager.save(sessionWith(sessionId, history(2)));
    const diskBefore = fs.readFileSync(getSessionFilePath(sessionId), "utf8");

    await expect(
      historyManager.save(sessionWith(sessionId, history(3)), {
        measureFullConversation: () => {
          throw new Error("measurement exploded");
        },
      }),
    ).rejects.toThrowError("measurement exploded");

    expect(fs.readFileSync(getSessionFilePath(sessionId), "utf8")).toBe(
      diskBefore,
    );
  });
});

describe("measureFullConversation — construction parity with the send path", () => {
  const historyItems: Session["history"] = [
    {
      message: { role: "user", content: "hello", id: "u1" },
      contextItems: [],
    } as Session["history"][number],
  ];

  it("builds the request from the request's inputs (system message, rules, summary)", () => {
    const seen: { messages: ChatMessage[]; options: any } = {
      messages: [],
      options: undefined,
    };
    const result = measureFullConversation({
      history: historyItems,
      request: measurement({
        systemMessage: "BASE SYSTEM",
        rules: [
          {
            source: "rules-block",
            rule: "ALWAYS RULE",
            name: "always",
            alwaysApply: true,
          },
        ],
        conversationSummaryOverride: "SUMMARY TEXT",
      }),
      measure: (messages, options) => {
        seen.messages = messages;
        seen.options = options;
        return {
          inputTokens: 1,
          contextLength: 2,
          availableTokens: 3,
          contextPercentage: 0.5,
          exceedsContext: false,
        } as ChatTokenMeasurement;
      },
    });

    const system = seen.messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("BASE SYSTEM");
    expect(system.content).toContain("ALWAYS RULE");
    expect(system.content).toContain("SUMMARY TEXT");
    expect(result.meta.conversationRevision).toBe(7);
    expect(result.meta.constructionIdentity).toBe("identity-7");
  });

  it("derives the system-tools framework from the completion options", () => {
    // Native tools present ⇒ no framework (assistant tool calls stay as-is).
    const nativeCalls: ChatMessage[][] = [];
    measureFullConversation({
      history: [
        {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "t1",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          } as any,
          contextItems: [],
          toolCallStates: [
            {
              toolCallId: "t1",
              status: "done",
              toolCall: {
                id: "t1",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
              parsedArgs: {},
            } as any,
          ],
        } as any,
      ],
      request: measurement({
        tools: [{ type: "function", function: { name: "read_file" } } as any],
        completionOptions: {
          model: MODEL,
          tools: [{ type: "function", function: { name: "read_file" } }] as any,
        },
      }),
      measure: (messages) => {
        nativeCalls.push(messages);
        return {
          inputTokens: 1,
          contextLength: 2,
          availableTokens: 3,
          contextPercentage: 0.5,
          exceedsContext: false,
        };
      },
    });
    // No framework ⇒ the tool call is not rewritten as system-message text.
    expect(nativeCalls[0].some((m) => m.role === "tool")).toBe(true);
  });

  it("matches the requested schema version only", () => {
    expect(measurementSchemaMatches(measurement())).toBe(true);
    expect(
      measurementSchemaMatches(
        measurement({
          schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION + 1,
        }),
      ),
    ).toBe(false);
  });
});
