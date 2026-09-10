import { ChatHistoryItem } from "..";
import { extractFirstTurnItems } from "./firstTurn";

/**
 * 方案.md §十.1: one shared extractor, exercised once. The first turn is the
 * first `user` message up to (not including) the second `user` message.
 */

/** The GUI/Core always attach an id; the shared types do not require one. */
type IdItem = ChatHistoryItem & {
  message: ChatHistoryItem["message"] & { id: string };
};

let counter = 0;

function item(role: string, id = `${role}-${++counter}`): IdItem {
  return {
    message: { role, content: id, id } as IdItem["message"],
    contextItems: [],
  };
}

describe("extractFirstTurnItems", () => {
  it("returns nothing for an empty history", () => {
    expect(extractFirstTurnItems([])).toEqual([]);
  });

  it("returns nothing when there is no user message", () => {
    const history = [item("system"), item("assistant"), item("thinking")];
    expect(extractFirstTurnItems(history)).toEqual([]);
  });

  it("starts at the first user message even when others precede it", () => {
    const first = [item("system"), item("assistant")];
    const history = [...first, item("user"), item("assistant")];
    expect(extractFirstTurnItems(history)).toEqual(history.slice(2));
  });

  it("returns the whole history when only one user message exists", () => {
    const history = [item("user"), item("assistant"), item("assistant")];
    expect(extractFirstTurnItems(history)).toEqual(history);
  });

  it("keeps thinking and tool continuation items inside the first turn", () => {
    const history = [
      item("user", "u1"),
      item("thinking", "t1"),
      item("assistant", "a1"),
      item("tool", "tool1"),
      item("assistant", "a2"),
      item("user", "u2"),
      item("assistant", "a3"),
    ];
    expect(extractFirstTurnItems(history).map((i) => i.message.id)).toEqual([
      "u1",
      "t1",
      "a1",
      "tool1",
      "a2",
    ]);
  });

  it("stops before the second user message", () => {
    const history = [
      item("user", "u1"),
      item("assistant", "a1"),
      item("user", "u2"),
      item("assistant", "a2"),
    ];
    expect(extractFirstTurnItems(history).map((i) => i.message.id)).toEqual([
      "u1",
      "a1",
    ]);
  });

  it("does not mutate the input array", () => {
    const history = [item("user"), item("assistant"), item("user")];
    const before = history.slice();
    extractFirstTurnItems(history);
    expect(history).toEqual(before);
  });
});
