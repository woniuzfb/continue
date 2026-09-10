import * as fs from "fs";

import { v4 as uuidv4 } from "uuid";

import { Session } from "..";
import historyManager from "./history";
import { resetMessageIdAllocations } from "./messageIdStabilization";
import { getSessionFilePath, getSessionsFolderPath } from "./paths";

/**
 * P3 of `bugs/Legacy_messageID_stabilization_设计.md`: the named
 * `history/migrateIds` action writes the ids this process already assigned (P2)
 * into the session file — and **only** into missing `message.id` slots.
 *
 * The fixtures are written with `fs.writeFileSync` (NOT `historyManager.save`)
 * so the on-disk form stays deliberately "fat": a full `<file_content>` block,
 * an inline base64 image with an `editorState` twin, and a plain (non-delta)
 * promptLog. If migration ever went through `load()` + `save()`, those fields
 * would be rewritten and the "only ids changed" assertions would fail.
 */

function readId(item: Session["history"][number]): string | undefined {
  return (item.message as { id?: string }).id;
}

function sessionPath(sessionId: string): string {
  return getSessionFilePath(sessionId);
}

function writeRawSession(session: Session): void {
  fs.writeFileSync(
    sessionPath(session.sessionId),
    JSON.stringify(session, undefined, 2),
  );
}

function readRawSession(sessionId: string): Session {
  return JSON.parse(fs.readFileSync(sessionPath(sessionId), "utf8"));
}

function readRawText(sessionId: string): string {
  return fs.readFileSync(sessionPath(sessionId), "utf8");
}

/** Fat, un-normalized legacy history (see the file header). */
function fatLegacyHistory(): Session["history"] {
  return [
    {
      message: {
        role: "user",
        content:
          "Files attached:\n\n" +
          '<file_content path="src/a.ts">\n' +
          "const x = 1;\n".repeat(30) +
          "</file_content>\n" +
          "\nplease review",
        metadata: { attachments: [{ path: "src/a.ts" }] },
      },
      contextItems: [],
    },
    {
      message: {
        role: "user",
        content: [
          { type: "text", text: "and this image" },
          {
            type: "imageUrl",
            imageUrl: { url: `data:image/png;base64,${"A".repeat(256)}` },
          },
        ],
      },
      contextItems: [],
      editorState: { type: "doc", content: [] },
    },
    {
      message: { role: "assistant", content: "ok" },
      contextItems: [],
      promptLogs: [
        {
          modelTitle: "m",
          modelProvider: "p",
          completion: "ok",
          prompt: "P".repeat(4000),
        },
      ],
    },
  ];
}

function fatLegacySession(): Session {
  return {
    sessionId: uuidv4(),
    title: "fat legacy",
    workspaceDirectory: "w",
    history: fatLegacyHistory(),
  };
}

function numberedHistory(count: number): Session["history"] {
  return Array.from({ length: count }, (_, i) => ({
    message: {
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    },
    contextItems: [],
  }));
}

/** inode changes on every atomic replace (rename swaps in a new file). */
function inodeOf(sessionId: string): number {
  return fs.statSync(sessionPath(sessionId)).ino;
}

describe("history/migrateIds (Legacy message ID P3)", () => {
  beforeEach(() => resetMessageIdAllocations());

  test("writes exactly the ids P2 already handed out, and they survive a reload", async () => {
    const session = fatLegacySession();
    writeRawSession(session);
    const { sessionId } = session;

    // P2 assigns ids in-process; the GUI would be holding these right now.
    const loaded = historyManager.load(sessionId);
    const idsBefore = loaded.history.map(readId);
    expect(idsBefore.every((id) => typeof id === "string")).toBe(true);

    const result = await historyManager.migrateMessageIds(sessionId);
    expect(result).toEqual({ migrated: true, addedCount: 3 });

    // Simulate a reload: drop the process table, then re-read from disk.
    resetMessageIdAllocations(sessionId);
    const reloaded = historyManager.load(sessionId);
    expect(reloaded.history.map(readId)).toEqual(idsBefore);
  });

  test("changes nothing except message.id", async () => {
    const session = fatLegacySession();
    writeRawSession(session);
    const before = JSON.parse(readRawText(session.sessionId));
    const bytesBefore = readRawText(session.sessionId);

    await historyManager.migrateMessageIds(session.sessionId);

    const after = JSON.parse(readRawText(session.sessionId));
    // The file must have grown by ids only.
    expect(after).not.toEqual(before);
    expect(readRawText(session.sessionId)).not.toBe(bytesBefore);

    for (const item of after.history) {
      expect(typeof item.message.id).toBe("string");
      delete item.message.id;
    }
    expect(after).toEqual(before);
  });

  test("never rewrites an id that is already on disk", async () => {
    const sessionId = uuidv4();
    writeRawSession({
      sessionId,
      title: "mixed",
      workspaceDirectory: "w",
      history: [
        {
          message: { role: "user", content: "m0", id: "keep-0" },
          contextItems: [],
        },
        { message: { role: "assistant", content: "m1" }, contextItems: [] },
        {
          message: { role: "user", content: "m2", id: "keep-2" },
          contextItems: [],
        },
      ],
    });

    const result = await historyManager.migrateMessageIds(sessionId);

    expect(result).toEqual({ migrated: true, addedCount: 1 });
    const after = readRawSession(sessionId);
    expect(readId(after.history[0])).toBe("keep-0");
    expect(readId(after.history[1])).toEqual(expect.any(String));
    expect(readId(after.history[2])).toBe("keep-2");
  });

  test("fills a frozen head and an already-persisted tail in one pass", async () => {
    const sessionId = uuidv4();
    const history = numberedHistory(30);
    const tailIds: string[] = [];
    for (let i = 20; i < 30; i++) {
      const id = `tail-${i}`;
      (history[i].message as { id?: string }).id = id;
      tailIds.push(id);
    }
    writeRawSession({
      sessionId,
      title: "frozen head",
      workspaceDirectory: "w",
      history,
    });

    // No GUI window, no historyLoadedOffset involved: migration works on the
    // whole on-disk file.
    const result = await historyManager.migrateMessageIds(sessionId);

    expect(result).toEqual({ migrated: true, addedCount: 20 });
    const after = readRawSession(sessionId);
    expect(after.history).toHaveLength(30);
    for (let i = 0; i < 20; i++) {
      expect(readId(after.history[i])).toEqual(expect.any(String));
    }
    for (let i = 20; i < 30; i++) {
      expect(readId(after.history[i])).toBe(tailIds[i - 20]);
    }
  });

  test("is idempotent: the second run is a no-op that does not write", async () => {
    const session = fatLegacySession();
    writeRawSession(session);
    const { sessionId } = session;

    const first = await historyManager.migrateMessageIds(sessionId);
    expect(first).toEqual({ migrated: true, addedCount: 3 });

    const inodeBefore = inodeOf(sessionId);
    const bytesBefore = readRawText(sessionId);

    const second = await historyManager.migrateMessageIds(sessionId);

    expect(second).toEqual({ migrated: false, addedCount: 0 });
    expect(inodeOf(sessionId)).toBe(inodeBefore);
    expect(readRawText(sessionId)).toBe(bytesBefore);
  });

  test("treats a session that already has every id as a no-op", async () => {
    const sessionId = uuidv4();
    const history = numberedHistory(4);
    history.forEach((item, i) => {
      (item.message as { id?: string }).id = `id-${i}`;
    });
    writeRawSession({
      sessionId,
      title: "complete",
      workspaceDirectory: "w",
      history,
    });

    const inodeBefore = inodeOf(sessionId);
    const result = await historyManager.migrateMessageIds(sessionId);

    expect(result).toEqual({ migrated: false, addedCount: 0 });
    expect(inodeOf(sessionId)).toBe(inodeBefore);
  });

  test("rejects a corrupt file with SESSION_FILE_INVALID and leaves it byte-identical", async () => {
    const sessionId = uuidv4();
    const broken = "{ this is not json";
    fs.writeFileSync(sessionPath(sessionId), broken);

    await expect(
      historyManager.migrateMessageIds(sessionId),
    ).rejects.toMatchObject({ code: "SESSION_FILE_INVALID" });

    expect(readRawText(sessionId)).toBe(broken);
  });

  test("rejects a missing file with SESSION_FILE_INVALID", async () => {
    await expect(
      historyManager.migrateMessageIds(uuidv4()),
    ).rejects.toMatchObject({ code: "SESSION_FILE_INVALID" });
  });

  test("a failed atomic write reports MESSAGE_ID_MIGRATION_FAILED and keeps the original file", async () => {
    const session = fatLegacySession();
    writeRawSession(session);
    const { sessionId } = session;
    const before = readRawText(sessionId);

    // Deterministic write-failure injection: freeze the clock so the temp file
    // name is predictable, then put a *directory* where that temp file must be
    // written. The session lock and the strict read are untouched, so the
    // failure lands exactly on the write step.
    const frozenNow = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(frozenNow);
    const tmpPath = `${sessionPath(sessionId)}.tmp-${process.pid}-${frozenNow}`;
    fs.mkdirSync(tmpPath);
    try {
      await expect(
        historyManager.migrateMessageIds(sessionId),
      ).rejects.toMatchObject({ code: "MESSAGE_ID_MIGRATION_FAILED" });
    } finally {
      nowSpy.mockRestore();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }

    expect(readRawText(sessionId)).toBe(before);
    expect(readRawSession(sessionId).history.map(readId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("shares the session lock with history/save and leaves no temp files behind", async () => {
    const session = fatLegacySession();
    writeRawSession(session);
    const { sessionId } = session;

    const loaded = historyManager.load(sessionId);
    const withAppend: Session = {
      ...loaded,
      history: [
        ...loaded.history,
        {
          message: { role: "user" as const, content: "appended" },
          contextItems: [],
        },
      ],
    };

    await Promise.all([
      historyManager.save(withAppend),
      historyManager.migrateMessageIds(sessionId),
    ]);

    // Serialized by the shared per-session lock: whichever ran last left a
    // complete, parseable file and no half-written temp file.
    const finalRaw = readRawSession(sessionId);
    expect(Array.isArray(finalRaw.history)).toBe(true);
    expect(finalRaw.history.length).toBeGreaterThanOrEqual(3);

    const leftovers = fs
      .readdirSync(getSessionsFolderPath())
      .filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
