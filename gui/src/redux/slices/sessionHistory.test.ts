import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "./sessionHistory";
import {
  applyStreamUpdatesToHistory,
  mergeSplitReplies,
} from "./sessionHistory";

function item(
  id: string,
  role: "user" | "assistant" | "thinking",
  content = "",
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function merged(
  id: string,
  content: string,
  sourceMessageIds: string[],
  conversationSummary?: string,
): ChatHistoryItemWithMessageId {
  return {
    ...item(id, "assistant", content),
    ...(conversationSummary ? { conversationSummary } : {}),
    mergedReplyProvenance: {
      sourceMessageIds,
      firstSourceMessageId: sourceMessageIds[0],
      lastSourceMessageId: sourceMessageIds[sourceMessageIds.length - 1],
    },
  };
}

describe("mergeSplitReplies provenance", () => {
  it("records the raw members behind a merged bubble, in disk order", () => {
    const history = [
      item("u1", "user", "q1"),
      item("a1", "assistant", "first answer"),
      item("u2", "user", "q2"),
      item("a2", "assistant", "part one "),
      item("t2", "thinking", "why"),
      item("a3", "assistant", "part two"),
      item("t3", "thinking", "more"),
    ];

    const result = mergeSplitReplies(history);

    // u1 / a1 / u2 / merged
    expect(result).toHaveLength(4);
    // The first reply group is exempt (servers may derive the session id from
    // it), so it must stay byte-identical.
    expect(result[1]).toBe(history[1]);

    const bubble = result[3];
    expect(bubble.message.id).toBe("a2");
    expect(bubble.message.content).toBe("part one part two");
    expect(bubble.mergedReplyProvenance).toEqual({
      sourceMessageIds: ["a2", "t2", "a3", "t3"],
      firstSourceMessageId: "a2",
      lastSourceMessageId: "t3",
    });
    // The carrier is the last raw member by disk order, regardless of role —
    // here a `thinking` item, which Core's compaction still accepts as the
    // "summary covers up to this index" boundary.
    expect(bubble.mergedReplyProvenance?.lastSourceMessageId).toBe("t3");
  });

  it("flattens the members of an already-merged item when it is merged again", () => {
    // A second prepend can group an earlier merged bubble with newer items. Its
    // own id is only the group's first assistant, so the older members survive
    // solely through the previous provenance.
    const previous = merged("a2", "merged body", ["a2", "t2", "a3", "t3"]);
    const history = [
      item("u0", "user", "q0"),
      item("a0", "assistant", "first group"),
      item("u1", "user", "q1"),
      item("b1", "assistant", "b1 body"),
      item("b2", "assistant", "b2 body"),
      previous,
    ];

    const result = mergeSplitReplies(history);
    const bubble = result[result.length - 1];

    expect(bubble.message.id).toBe("b1");
    // Without recursion this would be ["b1","b2","a2"] — losing t2/a3/t3 and
    // pointing lastSourceMessageId at a raw item that may no longer exist.
    expect(bubble.mergedReplyProvenance?.sourceMessageIds).toEqual([
      "b1",
      "b2",
      "a2",
      "t2",
      "a3",
      "t3",
    ]);
    expect(bubble.mergedReplyProvenance?.lastSourceMessageId).toBe("t3");
  });

  it("treats an item without provenance as a single disk source", () => {
    // A successful save clears provenance in the separate persistence lifecycle
    // tests; `mergeSplitReplies` only needs to honour the resulting runtime shape.
    // Such an item contributes just its own id to a later merge.
    const persisted = merged("a2", "merged body", ["a2", "t2", "a3", "t3"]);
    delete persisted.mergedReplyProvenance;
    const history = [
      item("u0", "user", "q0"),
      item("a0", "assistant", "first group"),
      item("u1", "user", "q1"),
      item("b1", "assistant", "b1 body"),
      item("b2", "assistant", "b2 body"),
      persisted,
    ];

    const result = mergeSplitReplies(history);
    const bubble = result[result.length - 1];

    expect(bubble.mergedReplyProvenance?.sourceMessageIds).toEqual([
      "b1",
      "b2",
      "a2",
    ]);
    expect(bubble.mergedReplyProvenance?.lastSourceMessageId).toBe("a2");
  });

  it("carries a summary held by a non-first group member onto the bubble", () => {
    // The compact carrier is whichever item the user compacted, so it can be a
    // later fragment. Inheriting only `firstAssistant` would drop the summary:
    // `ConversationSummary` renders from the item field, and Core's
    // `latestSummaryOf` scans for the same field — a save would then erase it.
    const history = [
      item("u1", "user", "q1"),
      item("a1", "assistant", "first group"),
      item("u2", "user", "q2"),
      item("a2", "assistant", "part one "),
      item("t2", "thinking", "why"),
      { ...item("a3", "assistant", "part two"), conversationSummary: "S" },
    ];

    const bubble = mergeSplitReplies(history)[3];

    expect(bubble.message.id).toBe("a2");
    expect(bubble.conversationSummary).toBe("S");
  });

  it("keeps the summary Core would have reported when several members have one", () => {
    // Core scans the disk backwards and reports the LAST summary. The bubble
    // stands for the whole group, so it must keep that same one.
    const history = [
      item("u1", "user", "q1"),
      item("a1", "assistant", "first group"),
      item("u2", "user", "q2"),
      { ...item("a2", "assistant", "part one"), conversationSummary: "early" },
      item("t2", "thinking", "why"),
      { ...item("a3", "assistant", "part two"), conversationSummary: "late" },
    ];

    expect(mergeSplitReplies(history)[3].conversationSummary).toBe("late");
  });

  it("does not invent a summary when no member has one", () => {
    const history = [
      item("u1", "user", "q1"),
      item("a1", "assistant", "first group"),
      item("u2", "user", "q2"),
      item("a2", "assistant", "part one "),
      item("t2", "thinking", "why"),
      item("a3", "assistant", "part two"),
    ];

    expect(mergeSplitReplies(history)[3].conversationSummary).toBeUndefined();
  });
});

describe("tool call states keep one identity per call (方案.md §7.4)", () => {
  function item(role: "user" | "assistant"): ChatHistoryItemWithMessageId {
    return {
      message: { id: `m-${role}-${Math.random()}`, role, content: "" } as any,
      contextItems: [],
    };
  }

  function stream(history: ChatHistoryItemWithMessageId[], messages: any[]) {
    applyStreamUpdatesToHistory(
      { history, dontMergeReplyBubbles: true },
      messages,
    );
    return history[history.length - 1];
  }

  it("adopts an unidentified fragment instead of pushing a second state", () => {
    // Reported: the approval bar showed two rows for ONE terminal command (only the first row
    // carried the key hints). Cause: the opening fragment has no id, so the state is created with
    // `toolCallId: ""`; the next fragment carries the real id, matches nothing, and the old code
    // pushed a second state.
    const history = [item("user"), item("assistant")];
    const last = stream(history, [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            type: "function",
            function: { name: "run_terminal_command", arguments: "" },
          },
        ],
      },
    ]);
    stream(history, [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "run_terminal_command",
              arguments: '{"command":"git status"}',
            },
          },
        ],
      },
    ]);

    const states = history[history.length - 1].toolCallStates ?? [];
    expect(states).toHaveLength(1);
    expect(states[0].toolCallId).toBe("call_1");
    expect(states[0].toolCall.function.arguments).toBe(
      '{"command":"git status"}',
    );
    expect(last).toBeTruthy();
  });

  it("keeps two genuinely parallel calls apart", () => {
    // The safety side of the same rule: two identified calls must never be merged.
    const history = [item("user"), item("assistant")];
    stream(history, [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "run_terminal_command",
              arguments: '{"command":"ls"}',
            },
          },
          {
            id: "call_2",
            type: "function",
            function: {
              name: "run_terminal_command",
              arguments: '{"command":"pwd"}',
            },
          },
        ],
      },
    ]);
    expect(
      (history[history.length - 1].toolCallStates ?? []).map(
        (s) => s.toolCallId,
      ),
    ).toEqual(["call_1", "call_2"]);
  });

  it("does not adopt a placeholder belonging to another tool", () => {
    const history = [item("user"), item("assistant")];
    stream(history, [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            type: "function",
            function: { name: "read_file", arguments: '{"filepath":"a.ts"}' },
          },
        ],
      },
    ]);
    stream(history, [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_2",
            type: "function",
            function: {
              name: "run_terminal_command",
              arguments: '{"command":"ls"}',
            },
          },
        ],
      },
    ]);
    expect(
      (history[history.length - 1].toolCallStates ?? []).map(
        (s) => `${s.toolCallId}:${s.toolCall.function.name}`,
      ),
    ).toEqual([":read_file", "call_2:run_terminal_command"]);
  });
});
