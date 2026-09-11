import { render } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";
import { IdeMessengerProvider } from "../../context/IdeMessenger";
import { SessionScope } from "./TipTapEditor/SessionScope";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
import ContextStatus from "./ContextStatus";

/**
 * 方案.md §五.16.6 / 验收项「ContextStatus 改读 fullConversationMetrics」。
 *
 * 这个组件曾经读四个 legacy 零散字段（`contextPercentage` / `isPruned` /
 * `contextInputTokens` / `contextLength`），Stage 2E 之后它们已下线：唯一数据源是
 * `fullConversationMetrics`（完整逻辑会话指标），可信度只影响「能否被自动决策当权威」，
 * 不影响显示 —— stale 的 last-known 数值必须照常画出来，而不是掉到 0。
 */

function item(
  id: string,
  role: "user" | "assistant",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

const RING = "context-status-ring";
/** ringSize 14 / stroke 2 ⇒ r = 6, circumference = 2πr. */
const CIRCUMFERENCE = 2 * Math.PI * 6;

function dashOffsetOf(ring: SVGElement): number {
  // The testid is on the <svg>; the progress arc is its second <circle>.
  const arc = ring.querySelectorAll("circle")[1];
  return Number(arc.getAttribute("stroke-dashoffset"));
}

function makeStore(overrides: Parameters<typeof initialSessionRuntime>[2]) {
  const runtime = initialSessionRuntime("s1", "Chat", {
    history: [item("u1", "user", "hi"), item("a1", "assistant", "yo")],
    ...overrides,
  });
  const store = createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat", loadState: "loaded" },
      },
      sessionsById: { s1: runtime },
    },
  });
  return store;
}

function renderStatus(store: ReturnType<typeof makeStore>) {
  return render(
    <Provider store={store}>
      <IdeMessengerProvider messenger={store.mockIdeMessenger}>
        <SessionScope sessionId="s1">
          <ContextStatus />
        </SessionScope>
      </IdeMessengerProvider>
    </Provider>,
  );
}

describe("ContextStatus reads the full-conversation metrics (Stage 2E)", () => {
  it("draws the ring from the full snapshot", () => {
    const store = makeStore({
      fullConversationMetrics: {
        inputTokens: 84000,
        contextLength: 200000,
        availableTokens: 100000,
        contextPercentage: 0.42,
        exceedsContext: false,
      },
      fullConversationMetricsMeta: {
        conversationRevision: 0,
        constructionIdentity: "identity",
        schemaVersion: 1,
      },
      fullConversationMetricsEnvironment: {
        rules: [],
        tools: [],
        experimental: undefined,
        skipBaseSystemMessage: false,
        modelsByRole: [],
        selectedModelByRole: undefined,
        toolSettings: {},
        toolGroupSettings: {},
        ruleSettings: {},
        chatModelTitle: undefined,
        mode: "chat",
        hasReasoningEnabled: undefined,
      },
    });
    const { getByTestId } = renderStatus(store);
    const ring = getByTestId(RING) as unknown as SVGElement;

    expect(dashOffsetOf(ring)).toBeCloseTo(CIRCUMFERENCE * (1 - 0.42), 5);
    // < 60% ⇒ description color, not the warning/error band.
    expect(ring.getAttribute("class")).toContain("text-description");
  });

  it("keeps showing the last-known value while the snapshot is stale", () => {
    // No meta / no environment stamp ⇒ the selector reports `stale`. The ring must
    // still show that number: freshness gates automatic decisions, not display.
    const store = makeStore({
      fullConversationMetrics: {
        inputTokens: 180000,
        contextLength: 200000,
        availableTokens: 1000,
        contextPercentage: 0.9,
        exceedsContext: false,
      },
    });
    const { getByTestId } = renderStatus(store);
    const ring = getByTestId(RING) as unknown as SVGElement;

    expect(dashOffsetOf(ring)).toBeCloseTo(CIRCUMFERENCE * (1 - 0.9), 5);
    expect(ring.getAttribute("class")).toContain("text-error");
  });

  it("fills the ring when the conversation exceeds the budget", () => {
    // `contextPercentage` may exceed 1 (方案.md §五.16.3): the ring clamps at full
    // and the color comes from `exceedsContext`, not from a `didPrune` mirror.
    const store = makeStore({
      fullConversationMetrics: {
        inputTokens: 140000,
        contextLength: 100000,
        availableTokens: 0,
        contextPercentage: 1.4,
        exceedsContext: true,
      },
    });
    const { getByTestId } = renderStatus(store);
    const ring = getByTestId(RING) as unknown as SVGElement;

    expect(dashOffsetOf(ring)).toBe(0);
    expect(ring.getAttribute("class")).toContain("text-error");
  });

  it("clamps a saturated (over-budget) percentage to a full ring", () => {
    // 方案.md §7.1.4: a non-positive budget reports a very large but **finite**
    // percentage. The UI math (`× 100`) must stay finite too, otherwise the
    // non-finite number simply moves one layer up.
    const store = makeStore({
      fullConversationMetrics: {
        inputTokens: 140000,
        contextLength: 100000,
        availableTokens: -1000,
        contextPercentage: Number.MAX_SAFE_INTEGER,
        exceedsContext: true,
      },
    });
    const { getByTestId } = renderStatus(store);
    const ring = getByTestId(RING) as unknown as SVGElement;

    expect(Number.isFinite(dashOffsetOf(ring))).toBe(true);
    expect(dashOffsetOf(ring)).toBe(0);
    expect(ring.getAttribute("class")).toContain("text-error");
  });

  it("draws an empty ring when there is no usable snapshot at all", () => {
    const { getByTestId } = renderStatus(makeStore({}));
    const ring = getByTestId(RING) as unknown as SVGElement;

    expect(dashOffsetOf(ring)).toBeCloseTo(CIRCUMFERENCE, 5);
    expect(ring.getAttribute("class")).toContain("text-description");
  });
});
