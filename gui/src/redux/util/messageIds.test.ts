import type { ChatHistoryItem, ChatMessage } from "core";
import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { ensureMessageIds, ensureMessageIdsWithReport } from "./messageIds";

/**
 * P4b-2. The helper stays the GUI fallback for hosts that do not return ids,
 * but it now reports how much it had to mint, so a silent regression cannot hide
 * behind it.
 *
 * Reference behaviour matters as much as the values: a load that changes nothing
 * must not produce a new array, and items that already carry an id must not be
 * copied.
 */

function item(
  message: ChatMessage,
  extra: Partial<ChatHistoryItem> = {},
): ChatHistoryItem {
  return { message, contextItems: [], ...extra };
}

function user(content: string) {
  return item({ role: "user", content });
}

function withId(message: ChatMessage, id: string): ChatHistoryItem {
  return item({ ...message, id } as ChatMessage);
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("ensureMessageIdsWithReport", () => {
  it("reports nothing and keeps the input array when every item has an id", () => {
    const items = [
      withId({ role: "user", content: "hi" }, "u1"),
      withId({ role: "assistant", content: "yo" } as ChatMessage, "a1"),
    ];

    const report = ensureMessageIdsWithReport(items);

    expect(report.mintedCount).toBe(0);
    // Same reference: `history` identity is used for change detection elsewhere.
    expect(report.items).toBe(items);
  });

  it("mints only the missing ids and copies only those items", () => {
    const first = withId({ role: "user", content: "hi" }, "u1");
    const second = user("no id here");
    const third = withId(
      { role: "assistant", content: "yo" } as ChatMessage,
      "a1",
    );

    const report = ensureMessageIdsWithReport([first, second, third]);

    expect(report.mintedCount).toBe(1);
    expect(report.items).not.toBe([first, second, third]);
    // Items that were already fine keep their object identity...
    expect(report.items[0]).toBe(first);
    expect(report.items[2]).toBe(third);
    // ...only the id-less one is replaced, with a fresh uuid.
    expect(report.items[1]).not.toBe(second);
    expect((report.items[1].message as { id?: string }).id).toMatch(UUID_V4);
    expect(report.items[1].message).toMatchObject({
      role: "user",
      content: "no id here",
    });
  });

  it("leaves existing ids byte-identical", () => {
    const items = [
      withId({ role: "user", content: "a" }, "keep-me"),
      user("mint me"),
      withId({ role: "assistant", content: "b" } as ChatMessage, "keep-me-too"),
    ];

    const report = ensureMessageIdsWithReport(items);

    expect((report.items[0].message as { id: string }).id).toBe("keep-me");
    expect((report.items[1].message as { id: string }).id).toMatch(UUID_V4);
    expect((report.items[2].message as { id: string }).id).toBe("keep-me-too");
  });

  it("carries every message variant", () => {
    const items: ChatHistoryItem[] = [
      item({ role: "system", content: "sys" } as ChatMessage),
      item({ role: "user", content: "u" }),
      item({ role: "thinking", content: "t" } as ChatMessage),
      item({ role: "assistant", content: "a" } as ChatMessage),
      item({ role: "tool", content: "r", toolCallId: "call-1" } as ChatMessage),
    ];

    const report = ensureMessageIdsWithReport(items);

    expect(report.mintedCount).toBe(5);
    const ids = report.items.map(
      (entry) => (entry.message as { id: string }).id,
    );
    expect(ids.every((id) => UUID_V4.test(id))).toBe(true);
    // Distinct ids, and the variant-defining fields survive the copy.
    expect(new Set(ids).size).toBe(5);
    expect(report.items.map((entry) => entry.message.role)).toEqual([
      "system",
      "user",
      "thinking",
      "assistant",
      "tool",
    ]);
    expect((report.items[4].message as { toolCallId: string }).toolCallId).toBe(
      "call-1",
    );
  });

  it("preserves the rest of an item while minting its id", () => {
    const rich = item({ role: "assistant", content: "answer" } as ChatMessage, {
      editorState: { cursor: 3 },
      appliedRules: [{ id: "rule-1" } as never],
      conversationSummary: "sum",
    });

    const report = ensureMessageIdsWithReport([rich]);

    expect(report.mintedCount).toBe(1);
    expect(report.items[0].editorState).toEqual({ cursor: 3 });
    expect(report.items[0].appliedRules).toEqual([{ id: "rule-1" }]);
    expect(report.items[0].conversationSummary).toBe("sum");
  });

  it("handles an empty history as a no-op", () => {
    const items: ChatHistoryItem[] = [];
    const report = ensureMessageIdsWithReport(items);
    expect(report.mintedCount).toBe(0);
    expect(report.items).toBe(items);
  });

  it("keeps the items-only wrapper behaviourally identical", () => {
    const items = [user("a"), withId({ role: "user", content: "b" }, "b1")];

    const viaWrapper = ensureMessageIds(items);

    expect(viaWrapper.map((entry) => entry.message.role)).toEqual([
      "user",
      "user",
    ]);
    expect(
      viaWrapper.every(
        (entry) =>
          typeof (entry as ChatHistoryItemWithMessageId).message.id ===
          "string",
      ),
    ).toBe(true);
    // Existing ids are untouched by the wrapper too.
    expect((viaWrapper[1].message as { id: string }).id).toBe("b1");
    // And the no-op fast path survives: same array instance, no copy.
    const allWithIds = [withId({ role: "user", content: "a" }, "a1")];
    expect(ensureMessageIds(allWithIds)).toBe(allWithIds);
  });
});
