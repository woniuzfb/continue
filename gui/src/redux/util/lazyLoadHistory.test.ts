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

  it("never trims a row the viewport is showing (方案.md §7.2.8)", () => {
    // Regression: a 12-row window was trimmed to `max(4, currentTurnLength) = 4` rows right
    // after the terminal save, which deleted two rows that were on screen (the viewport showed
    // the last ~6) and collapsed the transcript at the exact moment the reply finished.
    const history = turns(6); // 12 rows
    const session = runtime(history, { loadedOffset: 10, loadedDiskCount: 12 });
    const plan = planHistoryTrim(session, 4, 10 + 12, 8);
    expect(plan?.keepCount).toBe(8);
    expect(plan?.removedGuiItems).toBe(4);
    expect(plan?.removedDiskItems).toBe(4);
  });

  it("trims nothing at all when the whole window is on screen", () => {
    const history = turns(6);
    const plan = planHistoryTrim(
      runtime(history, { loadedOffset: 10, loadedDiskCount: 12 }),
      4,
      22,
      12,
    );
    expect(plan).toBeNull();
  });

  it("keeps the floor below the limit and the current turn from winning", () => {
    const history = turns(6);
    // A viewport showing only the last row must not lower the limit.
    expect(
      planHistoryTrim(
        runtime(history, { loadedOffset: 10, loadedDiskCount: 12 }),
        4,
        22,
        1,
      )?.keepCount,
    ).toBe(4);
    // The current turn wins over a small floor.
    expect(
      planHistoryTrim(
        runtime(history, { loadedOffset: 10, loadedDiskCount: 12 }),
        4,
        22,
        3,
      )?.keepCount,
    ).toBe(4);
  });

  it("takes the floor from the view as-is", () => {
    // The floor already carries the scroll buffer (the view measures it in pixels, 方案.md
    // §7.2.8), so the planner only has to refuse to go below it.
    const history = turns(10); // 20 rows
    const session = runtime(history, { loadedOffset: 10, loadedDiskCount: 20 });
    expect(planHistoryTrim(session, 4, 30, 9)?.keepCount).toBe(9);
    // A floor below the limit or the current turn never lowers them.
    expect(planHistoryTrim(session, 4, 30, 1)?.keepCount).toBe(4);
  });

  it("trims nothing when the view's floor already covers the window", () => {
    // A floor equal to the whole window is what the view reports when it cannot spare a row
    // (for example when every row above the viewport renders zero height), and it must trim
    // nothing at all — not even by one row.
    const session = runtime(turns(6), {
      loadedOffset: 10,
      loadedDiskCount: 12,
    }); // 12 rows
    expect(planHistoryTrim(session, 4, 22, 12)).toBeNull();
    // One row of slack is enough to allow a (small) trim again.
    expect(planHistoryTrim(session, 4, 22, 11)?.keepCount).toBe(11);
  });

  it("ignores a nonsensical floor", () => {
    const history = turns(6);
    const session = runtime(history, { loadedOffset: 10, loadedDiskCount: 12 });
    // A negative or fractional measurement can only come from a broken measurement; it must
    // never make the trim keep fewer rows than the limit.
    expect(planHistoryTrim(session, 4, 22, -5)?.keepCount).toBe(4);
    // A fractional floor floors rather than rounding up: keeping one row fewer than asked is
    // still above the limit and the current turn.
    expect(planHistoryTrim(session, 4, 22, 5.7)?.keepCount).toBe(5);
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
