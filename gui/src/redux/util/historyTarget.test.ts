import { describe, expect, it } from "vitest";
import { ChatHistoryItem } from "core";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import {
  findDiskIndexByMessageId,
  findGuiIndexContainingMessageId,
  resolveHistoryTargetOnDisk,
} from "./historyTarget";

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
  sourceMessageIds: string[],
): ChatHistoryItemWithMessageId {
  return {
    ...item(id, "assistant", "merged body"),
    mergedReplyProvenance: {
      sourceMessageIds,
      firstSourceMessageId: sourceMessageIds[0],
      lastSourceMessageId: sourceMessageIds[sourceMessageIds.length - 1],
    },
  };
}

/** The disk still holds the raw group; the window shows one merged bubble. */
const RAW_DISK: ChatHistoryItem[] = [
  item("u1", "user", "q"),
  item("a1", "assistant", "part one"),
  item("t1", "thinking", "why"),
  item("a2", "assistant", "part two"),
];
const MERGED_WINDOW = [
  item("u1", "user", "q"),
  merged("a1", ["a1", "t1", "a2"]),
];

describe("resolveHistoryTargetOnDisk", () => {
  it("resolves a merged bubble's carrier in both coordinate systems", () => {
    // The carrier (方案 B: the last raw member in disk order) is a2. It exists on
    // disk as its own item, but in the window it is only reachable through the
    // bubble's provenance — the bubble's own id is the group's first assistant.
    expect(
      resolveHistoryTargetOnDisk({
        rawDiskHistory: RAW_DISK,
        guiHistory: MERGED_WINDOW,
        targetMessageId: "a2",
      }),
    ).toEqual({ diskIndex: 3, guiIndex: 1 });

    // Freeze the reason the two sides need different predicates: the disk
    // predicate applied to the window finds nothing, so a resolver that used it
    // for both arrays would report every pre-save merged compact as unresolvable.
    expect(findDiskIndexByMessageId(MERGED_WINDOW, "a2")).toBe(-1);
    expect(findGuiIndexContainingMessageId(MERGED_WINDOW, "a2")).toBe(1);
  });

  it("resolves the bubble's own id once its provenance has been cleared", () => {
    // After a successful save the disk holds the bubble itself, so both sides
    // match by id — no provenance needed.
    const savedBubble = merged("a1", ["a1", "t1", "a2"]);
    delete savedBubble.mergedReplyProvenance;

    expect(
      resolveHistoryTargetOnDisk({
        rawDiskHistory: [
          item("u1", "user", "q"),
          item("a1", "assistant", "merged body"),
        ],
        guiHistory: [item("u1", "user", "q"), savedBubble],
        targetMessageId: "a1",
      }),
    ).toEqual({ diskIndex: 1, guiIndex: 1 });
  });

  it("returns undefined when the window no longer holds the target", () => {
    // A trimmed/prepended window can miss the item even though the disk has it.
    // The caller must abort rather than guess an index.
    expect(
      resolveHistoryTargetOnDisk({
        rawDiskHistory: RAW_DISK,
        guiHistory: [item("u1", "user", "q")],
        targetMessageId: "a2",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the disk has no persisted id for the target", () => {
    // Legacy sessions: the window carries a uuid minted for this process, which
    // the disk never had. Only a real persisted id is matchable on the disk side.
    const legacyDisk: ChatHistoryItem[] = [
      item("u1", "user", "q"),
      { message: { role: "assistant", content: "legacy" }, contextItems: [] },
    ];
    const window = [
      item("u1", "user", "q"),
      item("minted-uuid", "assistant", "legacy"),
    ];

    expect(
      resolveHistoryTargetOnDisk({
        rawDiskHistory: legacyDisk,
        guiHistory: window,
        targetMessageId: "minted-uuid",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for an unknown target", () => {
    expect(
      resolveHistoryTargetOnDisk({
        rawDiskHistory: RAW_DISK,
        guiHistory: MERGED_WINDOW,
        targetMessageId: "nope",
      }),
    ).toBeUndefined();
  });

  it("does not confuse provenance membership with a neighbouring bubble's id", () => {
    const twoBubbles = [
      merged("a1", ["a1", "t1", "a2"]),
      item("u2", "user", "q2"),
      merged("a3", ["a3", "a4"]),
    ];
    // "a4" belongs to the second bubble only.
    expect(findGuiIndexContainingMessageId(twoBubbles, "a4")).toBe(2);
    // A uuid that merely looks similar is not a member.
    expect(findGuiIndexContainingMessageId(twoBubbles, "a")).toBe(-1);
  });
});
