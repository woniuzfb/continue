import { describe, expect, it } from "vitest";
import { normalizePersistedContextMetrics } from "./fullConversationMetrics";
import {
  FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
  CONVERSATION_SUMMARY_SEMANTICS_VERSION,
} from "core/util/fullConversationMetrics";

/**
 * 磁盘 `Session.contextMetrics` 的归一化（方案.md §五.16.5）。GUI 侧只剩这一件事
 * （发送路径的 compile 适配已在 Stage 2E 删除）：磁盘上可能是完整 Result、裸 snapshot
 * 或 legacy `didPrune` 形状，三种都要在同一处区分，并给出可信度。
 */

const snapshot = {
  inputTokens: 25,
  contextLength: 100,
  availableTokens: 80,
  contextPercentage: 0.25,
  exceedsContext: false,
};

describe("normalizePersistedContextMetrics (方案.md §五.16.5)", () => {
  it("restores a complete Result as value plus identity", () => {
    const result = {
      metrics: snapshot,
      meta: {
        conversationRevision: 4,
        constructionIdentity: "identity",
        schemaVersion: FULL_CONVERSATION_METRICS_SCHEMA_VERSION,
      },
    };
    expect(normalizePersistedContextMetrics(result)).toEqual({
      metrics: result.metrics,
      meta: result.meta,
      // 「可比较」：带完整身份。是否真的匹配当前环境由 selector 判定。
      freshness: "fresh",
    });
  });

  it("keeps a Result's numbers but downgrades a malformed meta to stale", () => {
    expect(
      normalizePersistedContextMetrics({
        metrics: snapshot,
        // 缺 schemaVersion：不能拿它当身份用。
        meta: { conversationRevision: 0, constructionIdentity: "" } as any,
      }),
    ).toEqual({ metrics: snapshot, freshness: "stale" });
  });

  it("treats a Result whose numbers are incomplete as unavailable", () => {
    expect(
      normalizePersistedContextMetrics({
        metrics: { inputTokens: 1, contextLength: 2 } as any,
        meta: {
          conversationRevision: 0,
          constructionIdentity: "i",
          schemaVersion: 1,
        },
      }),
    ).toEqual({ freshness: "unavailable" });
  });

  it("restores a bare snapshot as stale (no identity on disk)", () => {
    expect(normalizePersistedContextMetrics(snapshot)).toEqual({
      metrics: snapshot,
      freshness: "stale",
    });
  });

  it("converts the legacy didPrune shape and marks it stale", () => {
    const normalized = normalizePersistedContextMetrics({
      didPrune: true,
      contextPercentage: 0.9,
      inputTokens: 180,
      contextLength: 200,
    });
    expect(normalized.freshness).toBe("stale");
    expect(normalized.meta).toBeUndefined();
    expect(normalized.metrics).toEqual({
      inputTokens: 180,
      contextLength: 200,
      // 反推值：legacy 形状没有预算信息，只能给窗口剩余。
      availableTokens: 20,
      contextPercentage: 0.9,
      exceedsContext: true,
    });
  });

  it("tolerates a legacy shape without token counts", () => {
    expect(
      normalizePersistedContextMetrics({
        didPrune: false,
        contextPercentage: 0.1,
      }),
    ).toEqual({
      metrics: {
        inputTokens: 0,
        contextLength: 0,
        availableTokens: 0,
        contextPercentage: 0.1,
        exceedsContext: false,
      },
      freshness: "stale",
    });
  });

  it("refuses a legacy shape it cannot convert reliably", () => {
    // 没有百分比就无法画出占用环 —— 这不是「0%」，是「不可用」。
    expect(normalizePersistedContextMetrics({ didPrune: true } as any)).toEqual(
      {
        freshness: "unavailable",
      },
    );
    expect(
      normalizePersistedContextMetrics({
        didPrune: true,
        contextPercentage: Number.NaN,
      } as any),
    ).toEqual({ freshness: "unavailable" });
    expect(
      normalizePersistedContextMetrics({
        didPrune: "yes",
        contextPercentage: 0.5,
      } as any),
    ).toEqual({ freshness: "unavailable" });
  });

  it("reports absent metrics as unavailable, not as zero", () => {
    expect(normalizePersistedContextMetrics(undefined)).toEqual({
      freshness: "unavailable",
    });
  });

  it("exposes the schema version the gate compares", () => {
    expect(FULL_CONVERSATION_METRICS_SCHEMA_VERSION).toBe(1);
    expect(CONVERSATION_SUMMARY_SEMANTICS_VERSION).toBe(1);
  });
});
