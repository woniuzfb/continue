import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "./sessionHistory";
import { mergeSplitReplies } from "./sessionHistory";

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
): ChatHistoryItemWithMessageId {
  return {
    ...item(id, "assistant", content),
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
});
