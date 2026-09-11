import { describe, expect, it } from "vitest";
import {
  fullConversationMetricsFromCompileResult,
  legacyDiskContextMetricsFromFullConversation,
  persistedContextMetricsToRuntime,
} from "./fullConversationMetrics";
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  CONVERSATION_SUMMARY_SEMANTICS_VERSION,
} from "core/util/fullConversationMetrics";

/**
 * GUI 侧只剩过渡适配（方案.md §五.16.5）：发送载荷 compile 结果 → 快照，
 * 以及磁盘 `Session.contextMetrics` 的两种形状 ↔ 快照。identity 与契约类型本身由
 * `core/util/fullConversationMetrics.ts` 拥有，测试在 core。
 */

describe("full conversation metrics adapters (transitional, 方案.md §五.16.5)", () => {
  it("maps a compile result into the full snapshot", () => {
    expect(
      fullConversationMetricsFromCompileResult({
        didPrune: true,
        contextPercentage: 0.9,
        inputTokens: 180000,
        contextLength: 200000,
      }),
    ).toEqual({
      inputTokens: 180000,
      contextLength: 200000,
      // 过渡语义：窗口剩余量，Stage 2C 换成扣除输出预留与安全缓冲的可用预算。
      availableTokens: 20000,
      contextPercentage: 0.9,
      exceedsContext: true,
    });
  });

  it("tolerates a compile result without token counts", () => {
    expect(
      fullConversationMetricsFromCompileResult({
        didPrune: false,
        contextPercentage: 0.1,
      }),
    ).toMatchObject({ inputTokens: 0, contextLength: 0, availableTokens: 0 });
  });

  it("reads a legacy disk snapshot as value-only (no freshness identity)", () => {
    const legacy = {
      didPrune: false,
      contextPercentage: 0.25,
      inputTokens: 25,
      contextLength: 100,
    };
    const restored = persistedContextMetricsToRuntime(legacy);
    expect(restored.metrics).toMatchObject({
      inputTokens: 25,
      contextLength: 100,
      contextPercentage: 0.25,
      exceedsContext: false,
    });
    // No identity on disk ⇒ the gate must treat it as stale.
    expect(restored.meta).toBeUndefined();
  });

  it("reads a persisted full Result as value plus identity", () => {
    // Stage 2D: `history/save` writes this shape; freshness is then decided by the
    // gate comparing revision + construction identity + schema.
    const result = {
      metrics: {
        inputTokens: 25,
        contextLength: 100,
        availableTokens: 80,
        contextPercentage: 0.31,
        exceedsContext: false,
      },
      meta: {
        conversationRevision: 4,
        constructionIdentity: "identity",
        schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
      },
    };
    expect(persistedContextMetricsToRuntime(result)).toEqual({
      metrics: result.metrics,
      meta: result.meta,
    });
  });

  it("writes the legacy field shape when a legacy host needs one", () => {
    const snapshot = {
      inputTokens: 25,
      contextLength: 100,
      availableTokens: 80,
      contextPercentage: 0.25,
      exceedsContext: true,
    };
    expect(legacyDiskContextMetricsFromFullConversation(snapshot)).toEqual({
      didPrune: true,
      contextPercentage: 0.25,
      inputTokens: 25,
      contextLength: 100,
    });
  });

  it("keeps absent metrics absent in both directions", () => {
    expect(persistedContextMetricsToRuntime(undefined)).toEqual({});
    expect(
      legacyDiskContextMetricsFromFullConversation(undefined),
    ).toBeUndefined();
  });

  it("exposes the schema version the gate compares", () => {
    expect(FULL_CONVERSATION_METRICS_SCHEMA_VERSION).toBe(1);
    expect(CONVERSATION_SUMMARY_SEMANTICS_VERSION).toBe(1);
  });
});
