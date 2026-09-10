import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { getLazyLoadTrimLimit, planHistoryTrim } from "./lazyLoadHistory";

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

/** `turns` user/assistant pairs, ids `u1/a1` … */
function turns(count: number): ChatHistoryItemWithMessageId[] {
  const history: ChatHistoryItemWithMessageId[] = [];
  for (let i = 1; i <= count; i++) {
    history.push(item(`u${i}`, "user", `q${i}`));
    history.push(item(`a${i}`, "assistant", `r${i}`));
  }
  return history;
}

function runtime(
  history: ChatHistoryItemWithMessageId[],
  pagination: Partial<{
    truncated: boolean;
    loadedOffset: number;
    loadedDiskCount: number | undefined;
    totalCount: number | undefined;
  }> = {},
) {
  return initialSessionRuntime("s1", "Chat 1", {
    history,
    pagination: {
      truncated: true,
      loadedOffset: 0,
      loadedDiskCount: history.length,
      hasMore: true,
      loading: false,
      requestGeneration: 0,
      persistPending: false,
      ...pagination,
    },
  });
}

describe("getLazyLoadTrimLimit", () => {
  it("defaults to 4 and never returns less than one", () => {
    expect(getLazyLoadTrimLimit(undefined)).toBe(4);
    expect(getLazyLoadTrimLimit(6)).toBe(6);
    expect(getLazyLoadTrimLimit(0)).toBe(1);
    expect(getLazyLoadTrimLimit(-3)).toBe(1);
  });
});

describe("planHistoryTrim", () => {
  it("plans nothing when the window already fits the limit", () => {
    expect(planHistoryTrim(runtime(turns(2)), 4, 4)).toBeNull();
  });

  it("keeps the configured window and reports 1:1 disk accounting", () => {
    // 10 items, frozen head of 6, merged disk total 16.
    const plan = planHistoryTrim(
      runtime(turns(5), { loadedOffset: 6, loadedDiskCount: 10 }),
      4,
      16,
    );

    expect(plan).toEqual({
      keepCount: 4,
      removedGuiItems: 6,
      removedDiskItems: 6,
      retainedDiskItemCount: 4,
      fullDiskItemCount: 16,
    });
  });

  it("never splits the current turn when it is longer than the limit", () => {
    // The last user message opens a 6-item turn, so at least 6 must stay.
    const history = [
      item("u1", "user"),
      item("a1", "assistant"),
      item("u2", "user"),
      item("t2a", "assistant"),
      item("t2b", "assistant"),
      item("t2c", "assistant"),
      item("t2d", "assistant"),
      item("t2e", "assistant"),
    ];
    const plan = planHistoryTrim(
      runtime(history, { loadedOffset: 0, loadedDiskCount: 8 }),
      4,
      8,
    );

    expect(plan?.keepCount).toBe(6);
    expect(plan?.removedDiskItems).toBe(2);
    // The retained window still starts at its own user message.
    expect(plan?.retainedDiskItemCount).toBe(6);
  });

  it("plans nothing when the current turn fills the window", () => {
    const history = [
      item("u1", "user"),
      item("a1", "assistant"),
      item("a2", "assistant"),
      item("a3", "assistant"),
      item("a4", "assistant"),
    ];
    // last user at index 0 => whole window is the current turn
    expect(
      planHistoryTrim(runtime(history, { loadedDiskCount: 5 }), 4, 5),
    ).toBeNull();
  });

  it("trims a merged window once a save rewrote the disk tail", () => {
    // 方案.md §九.6: `loadedDiskCount` counts *raw* page items, so a merged
    // window reports more disk items than GUI items. That count is a PRE-save
    // value: a successful save appends `session.history` verbatim
    // (`core/util/history.ts:501`), so the disk tail becomes the GUI window and
    // the stale raw count must not veto the trim.
    const plan = planHistoryTrim(
      runtime(turns(3), { loadedOffset: 4, loadedDiskCount: 8 }),
      4,
      10,
    );

    expect(plan).toEqual({
      keepCount: 4,
      removedGuiItems: 2,
      removedDiskItems: 2,
      retainedDiskItemCount: 4,
      fullDiskItemCount: 10,
    });
  });

  it("plans nothing when the host did not report the disk count", () => {
    const plan = planHistoryTrim(
      runtime(turns(5), { loadedOffset: 0, loadedDiskCount: 10 }),
      4,
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("still trims a fully loaded session whose loadedDiskCount was cleared", () => {
    // `loadFullHistory` sets truncated=false + loadedDiskCount=undefined and
    // the whole history is in memory, so disk === the GUI array (1:1 by
    // construction) even with bubble merge on.
    const plan = planHistoryTrim(
      runtime(turns(5), {
        truncated: false,
        loadedOffset: 0,
        loadedDiskCount: undefined,
      }),
      4,
      10,
    );

    expect(plan).toEqual({
      keepCount: 4,
      removedGuiItems: 6,
      removedDiskItems: 6,
      retainedDiskItemCount: 4,
      fullDiskItemCount: 10,
    });
  });

  it("plans nothing when the disk count contradicts the window accounting", () => {
    // Core thinned the disk (or the response is stale): 16 !== 4 + 10.
    const plan = planHistoryTrim(
      runtime(turns(5), { loadedOffset: 4, loadedDiskCount: 10 }),
      4,
      13,
    );
    expect(plan).toBeNull();
  });

  it("treats a window without a user message as no current turn", () => {
    const history = [
      item("a1", "assistant"),
      item("a2", "assistant"),
      item("a3", "assistant"),
      item("a4", "assistant"),
      item("a5", "assistant"),
      item("a6", "assistant"),
    ];
    const plan = planHistoryTrim(
      runtime(history, { loadedOffset: 0, loadedDiskCount: 6 }),
      4,
      6,
    );
    expect(plan?.keepCount).toBe(4);
    expect(plan?.removedDiskItems).toBe(2);
  });

  it("does not mutate the input history", () => {
    const history = turns(5);
    const before = history.slice();
    planHistoryTrim(
      runtime(history, { loadedOffset: 0, loadedDiskCount: 10 }),
      4,
      10,
    );
    expect(history).toEqual(before);
  });
});
