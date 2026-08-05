import * as fs from "fs";

import { v4 as uuidv4 } from "uuid";

import { ChatHistoryItem, Session } from "..";
import historyManager from "./history";
import { getSessionFilePath } from "./paths";

/**
 * Regression tests for the lazy-loaded "truncated history" save path
 * (P2-3 / P2-3b / P2-3c / P2-3d / P2-3e). These lock down the data-integrity
 * guarantees:
 *
 *  P2-3: when only the TAIL of a session's history is loaded in memory
 *        (historyTruncated === true), save() must MERGE the frozen head from
 *        disk with the in-memory tail. If it cannot safely merge (e.g. the
 *        on-disk history is unexpectedly shorter than historyLoadedOffset, or
 *        the file is missing), it must REFUSE to write and leave the on-disk
 *        file untouched — never silently overwrite the full history with just
 *        the shorter in-memory tail.
 *
 *  Atomic write: a completed save must not leave any ".tmp-*" scratch files
 *        behind in the sessions directory.
 *
 *  NOTE (P2-3e): save() and delete() are now async (the cross-process lock no
 *        longer blocks the event loop). Every call below is awaited, and the
 *        test callbacks are async, so assertions run only after the write has
 *        actually completed.
 */

function msg(role: "user" | "assistant", text: string): ChatHistoryItem {
  return {
    message: { role, content: text },
    contextItems: [],
  };
}

function readDisk(sessionId: string): Session {
  return JSON.parse(fs.readFileSync(getSessionFilePath(sessionId), "utf8"));
}

describe("HistoryManager truncated-history save (regression)", () => {
  afterEach(() => {
    historyManager.clearAll();
  });

  it("merges the frozen disk head with the in-memory tail", async () => {
    const sessionId = uuidv4();
    // Full session with 5 items persisted to disk.
    const full: Session = {
      sessionId,
      title: "merge test",
      workspaceDirectory: "ws",
      history: [
        msg("user", "u0"),
        msg("assistant", "a0"),
        msg("user", "u1"),
        msg("assistant", "a1"),
        msg("user", "u2"),
      ],
    };
    await historyManager.save(full);

    // Simulate a lazy-loaded view: only the last 2 items are in memory,
    // the first 3 are "frozen" on disk (historyLoadedOffset = 3).
    const truncated: Session = {
      sessionId,
      title: "merge test",
      workspaceDirectory: "ws",
      history: [msg("assistant", "a1-edited"), msg("user", "u2")],
      historyTruncated: true,
      historyLoadedOffset: 3,
    };
    await historyManager.save(truncated);

    const onDisk = readDisk(sessionId);
    // Head (3 frozen) + tail (2 in-memory) === 5 items, no loss.
    expect(onDisk.history).toHaveLength(5);
    expect(onDisk.history[0].message.content as string).toBe("u0");
    expect(onDisk.history[3].message.content as string).toBe("a1-edited");
    expect(onDisk.history[4].message.content as string).toBe("u2");
  });

  it("REFUSES to save (no data loss) when offset exceeds on-disk length", async () => {
    const sessionId = uuidv4();
    const full: Session = {
      sessionId,
      title: "guard test",
      workspaceDirectory: "ws",
      history: [msg("user", "u0"), msg("assistant", "a0"), msg("user", "u1")],
    };
    await historyManager.save(full);
    const before = readDisk(sessionId);
    expect(before.history).toHaveLength(3);

    // Inconsistent state: claims 10 frozen head items but disk only has 3.
    // A destructive implementation would overwrite disk with just the tail.
    const bad: Session = {
      sessionId,
      title: "guard test",
      workspaceDirectory: "ws",
      history: [msg("user", "tail-only")],
      historyTruncated: true,
      historyLoadedOffset: 10,
    };
    await historyManager.save(bad);

    // Disk must be UNCHANGED — the frozen head was not dropped.
    const after = readDisk(sessionId);
    expect(after.history).toHaveLength(3);
    expect(after.history[0].message.content as string).toBe("u0");
    expect(after.history.some((h) => h.message.content === "tail-only")).toBe(
      false,
    );
  });

  it("leaves no .tmp scratch files behind after an atomic save", async () => {
    const sessionId = uuidv4();
    await historyManager.save({
      sessionId,
      title: "atomic test",
      workspaceDirectory: "ws",
      history: [msg("user", "hello")],
    });

    const sessionFile = getSessionFilePath(sessionId);
    const dir = sessionFile.slice(0, sessionFile.lastIndexOf("/"));
    const leftovers = fs
      .readdirSync(dir)
      .filter((f) => f.includes(`${sessionId}`) && f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
