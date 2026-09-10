import { v4 as uuidv4 } from "uuid";

import { Session } from "..";
import historyManager from "./history";
import { resetMessageIdAllocations } from "./messageIdStabilization";

/**
 * P2 of `bugs/Legacy_messageID_stabilization_设计.md`: `load()` assigns a
 * stable-in-process `message.id` to legacy (id-less) history items.
 *
 * Every test writes an **id-less** session to disk, so `load()` really does
 * have to mint — if a persisted id were present the stabilizer would be a no-op
 * and these assertions would be vacuous.
 */

const LEGACY_TOTAL = 100;

/** Id-less legacy history: alternating user/assistant, content "m<i>". */
function legacyHistory(count: number): Session["history"] {
  return Array.from({ length: count }, (_, i) => ({
    message: {
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    },
    contextItems: [],
  }));
}

async function saveLegacy(count: number): Promise<string> {
  const sessionId = uuidv4();
  await historyManager.save({
    sessionId,
    title: `legacy ${count}`,
    workspaceDirectory: "w",
    history: legacyHistory(count),
  });
  return sessionId;
}

function idAt(item: Session["history"][number]): string | undefined {
  return (item.message as { id?: string }).id;
}

/**
 * Map absolute history index -> assigned id for one page. Mirrors the tail
 * offset semantics documented in the design (`end = total - offset`), which is
 * exactly the arithmetic the stabilizer must NOT have to do itself.
 */
function pageIds(
  items: Session["history"],
  total: number,
  offset: number,
): Map<number, string | undefined> {
  const start = Math.max(0, total - offset - items.length);
  const result = new Map<number, string | undefined>();
  items.forEach((item, k) => result.set(start + k, idAt(item)));
  return result;
}

describe("Legacy message ID stabilization (P2)", () => {
  beforeEach(() => resetMessageIdAllocations());

  test("T1a: the same page read twice returns identical ids", async () => {
    const sessionId = await saveLegacy(LEGACY_TOTAL);

    const first = historyManager.loadPage(sessionId, 0, 50);
    const middle = historyManager.loadPage(sessionId, 50, 50);
    const again = historyManager.loadPage(sessionId, 0, 50);

    expect(first.total).toBe(LEGACY_TOTAL);
    // offset=0 and offset=50 are ADJACENT pages, not overlapping ones.
    expect([...pageIds(first.items, first.total, 0).keys()]).toEqual(
      Array.from({ length: 50 }, (_, i) => 50 + i),
    );
    expect([...pageIds(middle.items, middle.total, 50).keys()]).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );

    expect(pageIds(again.items, again.total, 0)).toEqual(
      pageIds(first.items, first.total, 0),
    );

    await historyManager.delete(sessionId);
  });

  test("T1b: the overlapping absolute range of two pages shares ids", async () => {
    const sessionId = await saveLegacy(LEGACY_TOTAL);

    const a = historyManager.loadPage(sessionId, 0, 50); // [50,100)
    const b = historyManager.loadPage(sessionId, 25, 50); // [25,75)

    const idsA = pageIds(a.items, a.total, 0);
    const idsB = pageIds(b.items, b.total, 25);

    // Real overlap is absolute [50,75).
    const overlap = [...idsA.keys()].filter((index) => idsB.has(index));
    expect(overlap).toEqual(Array.from({ length: 25 }, (_, i) => 50 + i));
    for (const index of overlap) {
      expect(idsB.get(index)).toBe(idsA.get(index));
    }

    await historyManager.delete(sessionId);
  });

  test("T2: ids follow the absolute index, not the window or fetch order", async () => {
    const sessionId = await saveLegacy(LEGACY_TOTAL);

    // Fetch the older window FIRST, then the newer one — a window-local key
    // would produce different ids depending on order.
    const olderFirst = historyManager.loadPage(sessionId, 25, 50); // [25,75)
    const newerSecond = historyManager.loadPage(sessionId, 0, 50); // [50,100)

    const idsOlder = pageIds(olderFirst.items, olderFirst.total, 25);
    const idsNewer = pageIds(newerSecond.items, newerSecond.total, 0);

    for (const index of [50, 60, 74]) {
      expect(idsNewer.get(index)).toBe(idsOlder.get(index));
      expect(idsOlder.get(index)).toEqual(expect.any(String));
    }

    await historyManager.delete(sessionId);
  });

  test("T2b: the streaming tail growing in place does not change any id", async () => {
    const sessionId = await saveLegacy(10);

    const before = historyManager.loadPage(sessionId, 0, 10);
    const idsBefore = pageIds(before.items, before.total, 0);

    // Simulate streaming: same array length, only the LAST item's content grows.
    // Disk stays id-less, so the stabilizer has to re-derive the table.
    const grown = legacyHistory(10);
    grown[9] = {
      message: {
        role: "assistant",
        content: "m9 plus a streamed continuation",
      },
      contextItems: [],
    };
    await historyManager.save({
      sessionId,
      title: `legacy 10`,
      workspaceDirectory: "w",
      history: grown,
    });

    const after = historyManager.loadPage(sessionId, 0, 10);
    const idsAfter = pageIds(after.items, after.total, 0);

    // Indices 0..8 are untouched; index 9 is the tail and keeps its identity.
    for (let i = 0; i < 10; i++) {
      expect(idsAfter.get(i)).toBe(idsBefore.get(i));
    }

    await historyManager.delete(sessionId);
  });

  test("appending a new turn keeps the ids of the existing items", async () => {
    const sessionId = await saveLegacy(10);

    const before = historyManager.loadPage(sessionId, 0, 10);
    const idsBefore = pageIds(before.items, before.total, 0);

    const appended = legacyHistory(10);
    appended.push({
      message: { role: "user", content: "m10" },
      contextItems: [],
    });
    await historyManager.save({
      sessionId,
      title: `legacy 10`,
      workspaceDirectory: "w",
      history: appended,
    });

    const after = historyManager.loadPage(sessionId, 0, 11);
    const idsAfter = pageIds(after.items, after.total, 0);

    for (let i = 0; i < 10; i++) {
      expect(idsAfter.get(i)).toBe(idsBefore.get(i));
    }
    expect(idsAfter.get(10)).toEqual(expect.any(String));
    expect(idsAfter.get(10)).not.toBe(idsBefore.get(9));

    await historyManager.delete(sessionId);
  });

  test("a persisted id is never rewritten, and id-less neighbours still get one", async () => {
    const sessionId = uuidv4();
    const persisted = "already-on-disk";
    await historyManager.save({
      sessionId,
      title: "mixed",
      workspaceDirectory: "w",
      history: [
        {
          message: { role: "user", content: "has id", id: persisted },
          contextItems: [],
        },
        {
          message: { role: "assistant", content: "no id" },
          contextItems: [],
        },
      ],
    });

    const loaded = historyManager.load(sessionId);

    expect(idAt(loaded.history[0])).toBe(persisted);
    expect(idAt(loaded.history[1])).toEqual(expect.any(String));
    expect(idAt(loaded.history[1])).not.toBe(persisted);

    await historyManager.delete(sessionId);
  });

  test("a whole-array rewrite (prepend) discards the table instead of mislabelling", async () => {
    const sessionId = await saveLegacy(10);

    const before = historyManager.loadPage(sessionId, 0, 10);
    const idsBefore = pageIds(before.items, before.total, 0);

    // Prepending shifts every index by one: the array is a different array, so
    // per D2 / §10.3 the table is discarded and ids are re-assigned. Pinned
    // here so the behaviour is explicit rather than accidental.
    const prepended = legacyHistory(10);
    prepended.unshift({
      message: { role: "system", content: "new head" },
      contextItems: [],
    });
    await historyManager.save({
      sessionId,
      title: "legacy 10",
      workspaceDirectory: "w",
      history: prepended,
    });

    const after = historyManager.loadPage(sessionId, 0, 11);
    const idsAfter = pageIds(after.items, after.total, 0);

    // Index 0 is the new head; the item that used to be index 0 now sits at 1.
    expect(idsAfter.get(0)).toEqual(expect.any(String));
    expect(idsAfter.get(0)).not.toBe(idsBefore.get(0));
    // Content still lines up 1:1 with the shifted indices, so nothing is lost.
    expect(after.items.map((i) => i.message.content)).toEqual(
      prepended.map((i) => i.message.content),
    );

    await historyManager.delete(sessionId);
  });
});
