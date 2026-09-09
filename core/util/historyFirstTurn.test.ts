import { v4 as uuidv4 } from "uuid";

import { ChatHistoryItem, Session } from "..";
import historyManager from "./history";

/**
 * 方案.md §十六「新增」+ §五.5: the disk first turn must be byte-identical
 * across save/reload, because the Local Provider derives its conversation key
 * from it.
 */

function user(id: string, content: string): ChatHistoryItem {
  return {
    message: { role: "user", content, id } as any,
    contextItems: [],
  };
}

function assistant(id: string, content: string): ChatHistoryItem {
  return {
    message: { role: "assistant", content, id } as any,
    contextItems: [],
  };
}

function thinking(id: string, content: string): ChatHistoryItem {
  return {
    message: { role: "thinking", content, id } as any,
    contextItems: [],
  };
}

describe("history first turn boundary", () => {
  const sessionId = uuidv4();
  const firstTurn = [
    user("u1", "first question"),
    thinking("t1", "reasoning"),
    assistant("a1", "first answer"),
  ];
  const secondTurn = [
    user("u2", "second question"),
    assistant("a2", "second answer"),
  ];

  const session: Session = {
    sessionId,
    title: "first turn boundary",
    workspaceDirectory: "workspaceDir",
    history: [...firstTurn, ...secondTurn],
  };

  test("save returns the disk first turn", async () => {
    const response = await historyManager.save(session);

    expect(response.firstTurnItems.map((i) => (i.message as any).id)).toEqual([
      "u1",
      "t1",
      "a1",
    ]);
    expect(response.totalHistoryCount).toBe(5);
  });

  test("loadPage returns the same first turn byte-for-byte", async () => {
    const saved = await historyManager.save(session);
    const page = historyManager.loadPage(sessionId, 0, 2);

    expect(JSON.stringify(page.firstTurnItems)).toBe(
      JSON.stringify(saved.firstTurnItems),
    );
  });

  test("a later save does not change the first turn", async () => {
    const first = await historyManager.save(session);
    const extended: Session = {
      ...session,
      history: [
        ...session.history,
        user("u3", "third question"),
        assistant("a3", "third answer"),
      ],
    };
    const second = await historyManager.save(extended);

    expect(JSON.stringify(second.firstTurnItems)).toBe(
      JSON.stringify(first.firstTurnItems),
    );
    expect(second.totalHistoryCount).toBe(7);
  });

  test("loadPage returns the latest summary only on the first page", async () => {
    const withSummary: Session = {
      ...session,
      history: session.history.map((item, index) =>
        index === 2 ? { ...item, conversationSummary: "compacted" } : item,
      ),
    };
    const saved = await historyManager.save(withSummary);
    expect(saved.latestConversationSummary).toEqual({
      sourceMessageId: "a1",
      sourceAbsoluteIndex: 2,
      content: "compacted",
    });

    const firstPage = historyManager.loadPage(sessionId, 0, 2);
    expect(firstPage.latestConversationSummary).toEqual(
      saved.latestConversationSummary,
    );

    // Later pages only carry items/hasMore/total (方案.md §十三.4).
    const laterPage = historyManager.loadPage(sessionId, 2, 2);
    expect(laterPage.latestConversationSummary).toBeUndefined();
    expect(laterPage.firstTurnItems).toEqual([]);
  });

  test("reasoning preference round-trips through save and load", async () => {
    const withReasoning: Session = {
      ...session,
      hasReasoningEnabled: true,
      reasoningPreferenceSource: "explicit",
    };
    await historyManager.save(withReasoning);

    const loaded = historyManager.load(sessionId);
    expect(loaded.hasReasoningEnabled).toBe(true);
    expect(loaded.reasoningPreferenceSource).toBe("explicit");

    const page = historyManager.loadPage(sessionId, 0, 2);
    expect(page.session.hasReasoningEnabled).toBe(true);
    expect(page.session.reasoningPreferenceSource).toBe("explicit");
  });

  test("a session without a user message has an empty first turn", async () => {
    const response = await historyManager.save({
      sessionId: uuidv4(),
      title: "no user",
      workspaceDirectory: "w",
      history: [assistant("a1", "orphan")],
    });

    expect(response.firstTurnItems).toEqual([]);
  });
});
