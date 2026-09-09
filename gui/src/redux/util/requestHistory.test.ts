import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { getCurrentTurnItems } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { buildRequestHistoryForSession } from "./requestHistory";

function item(
  id: string,
  role: "user" | "assistant",
  content = id,
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id,
      role,
      content,
    } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

const FIRST_TURN = [item("f1", "user", "first"), item("f2", "assistant", "r1")];
const TAIL = [item("t1", "user", "second"), item("t2", "assistant", "r2")];

describe("buildRequestHistoryForSession", () => {
  it("uses firstTurnItems + current turn on the fast path", () => {
    const session = initialSessionRuntime("s1", "S", {
      history: [...FIRST_TURN, ...TAIL],
      firstTurnItems: FIRST_TURN,
      persistence: {
        state: "clean",
        revision: 2,
        persistedRevision: 2,
        hasPersistedBaseline: true,
      },
    });

    const plan = buildRequestHistoryForSession(session);

    expect(plan.kind).toBe("ready");
    if (plan.kind === "ready") {
      expect(plan.requestHistory.map((i) => i.message.id)).toEqual([
        "f1",
        "f2",
        "t1",
        "t2",
      ]);
    }
  });

  it("does not duplicate the first turn on a brand-new session", () => {
    const session = initialSessionRuntime("s1", "S", {
      history: FIRST_TURN,
      firstTurnItems: FIRST_TURN,
      persistence: {
        state: "clean",
        revision: 1,
        persistedRevision: 1,
        hasPersistedBaseline: true,
      },
    });

    const plan = buildRequestHistoryForSession(session);

    expect(plan.kind).toBe("ready");
    if (plan.kind === "ready") {
      expect(plan.requestHistory.map((i) => i.message.id)).toEqual([
        "f1",
        "f2",
      ]);
    }
  });

  it("falls back to the full history without a persisted baseline", () => {
    const session = initialSessionRuntime("s1", "S", {
      history: [...FIRST_TURN, ...TAIL],
      firstTurnItems: FIRST_TURN,
      persistence: {
        state: "pending",
        revision: 1,
        persistedRevision: 0,
        hasPersistedBaseline: false,
      },
    });

    const plan = buildRequestHistoryForSession(session);

    expect(plan.kind).toBe("ready");
    if (plan.kind === "ready") {
      expect(plan.requestHistory).toHaveLength(4);
    }
  });

  it("requests a full load when the window is truncated and the fast path is unusable", () => {
    const session = initialSessionRuntime("s1", "S", {
      history: TAIL,
      firstTurnItems: [],
      pagination: {
        truncated: true,
        loadedOffset: 2,
        hasMore: true,
        loading: false,
        requestGeneration: 0,
        persistPending: false,
      },
    });

    expect(buildRequestHistoryForSession(session).kind).toBe(
      "needs-full-history",
    );
  });

  it("never falls back to a failed save's snapshot", () => {
    const session = initialSessionRuntime("s1", "S", {
      history: TAIL,
      firstTurnItems: FIRST_TURN,
      persistence: {
        state: "failed",
        revision: 3,
        persistedRevision: 2,
        hasPersistedBaseline: true,
        error: { code: "SESSION_SAVE_FAILED", message: "boom" },
      },
      pagination: {
        truncated: true,
        loadedOffset: 2,
        hasMore: true,
        loading: false,
        requestGeneration: 0,
        persistPending: false,
      },
    });

    expect(buildRequestHistoryForSession(session).kind).toBe(
      "needs-full-history",
    );
  });
});

describe("getCurrentTurnItems", () => {
  it("returns the last user message and everything after it", () => {
    const history = [...FIRST_TURN, ...TAIL, item("t3", "assistant", "r3")];
    expect(getCurrentTurnItems(history).map((i) => i.message.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });
});
