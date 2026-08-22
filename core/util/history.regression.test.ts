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

function assistantWithPromptLog(text: string, prompt: string): ChatHistoryItem {
  return {
    message: { role: "assistant", content: text },
    contextItems: [],
    promptLogs: [
      { modelTitle: "m", modelProvider: "local", prompt, completion: "ok" },
    ],
  };
}

function readDisk(sessionId: string): Session {
  return JSON.parse(fs.readFileSync(getSessionFilePath(sessionId), "utf8"));
}

function userWithImage(
  text: string,
  base64: string,
  editorState: unknown = undefined,
): ChatHistoryItem {
  return {
    message: {
      role: "user",
      content: [
        { type: "text", text },
        {
          type: "imageUrl",
          imageUrl: { url: `data:image/jpeg;base64,${base64}` },
        },
      ],
    },
    contextItems: [],
    ...(editorState === undefined ? {} : { editorState }),
  };
}

/** editorState 中等价于一张内联图的 TipTap 节点（含完整 base64 src）。 */
function imageEditorState(base64: string): any {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "看下这张图" },
          {
            type: "image",
            attrs: {
              src: `data:image/jpeg;base64,${base64}`,
              alt: "None",
              title: "None",
            },
          },
        ],
      },
    ],
  };
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

  it("does not partially strip an attachment containing a standalone closing tag", async () => {
    const sessionId = uuidv4();
    const content =
      '<file_content path="/tmp/example.ts">\n' +
      'const example = "file-content parser";\n' +
      "</file_content>\n" +
      "const afterLiteralTag = true;\n" +
      "</file_content>\n";
    await historyManager.save({
      sessionId,
      title: "attachment parser safety",
      workspaceDirectory: "ws",
      history: [
        {
          message: {
            role: "user",
            content,
            metadata: {
              attachments: [{ name: "example.ts", path: "/tmp/example.ts" }],
            },
          },
          contextItems: [],
        },
      ],
    });

    // The first standalone closing tag makes the span ambiguous. Retaining
    // the whole user message is preferable to saving a silently truncated one.
    const onDisk = readDisk(sessionId);
    expect(onDisk.history[0].message.content).toBe(content);
  });

  it("loadPage clamps offset beyond total instead of returning corrupt slices", async () => {
    const sessionId = uuidv4();
    await historyManager.save({
      sessionId,
      title: "page test",
      workspaceDirectory: "ws",
      history: [msg("user", "u0"), msg("assistant", "a0"), msg("user", "u1")],
    });

    // offset > total: a negative `end` would make slice() count from the end
    // and return the WRONG items; it must return an empty page instead.
    const beyond = historyManager.loadPage(sessionId, 10, 4);
    expect(beyond.items).toHaveLength(0);
    expect(beyond.hasMore).toBe(false);
    expect(beyond.total).toBe(3);

    // offset === total: also empty
    const atEnd = historyManager.loadPage(sessionId, 3, 4);
    expect(atEnd.items).toHaveLength(0);
    expect(atEnd.hasMore).toBe(false);

    // Normal page from the end still works
    const page = historyManager.loadPage(sessionId, 0, 2);
    expect(page.items.map((i) => i.message.content)).toEqual(["a0", "u1"]);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(3);
  });

  it("delete waits for an in-flight save (per-session lock) instead of orphaning the file", async () => {
    const sessionId = uuidv4();
    await historyManager.save({
      sessionId,
      title: "lock test",
      workspaceDirectory: "ws",
      history: [msg("user", "u0")],
    });

    // Simulate an in-flight save holding the per-session lock.
    const sessionFile = getSessionFilePath(sessionId);
    const lockDir = `${sessionFile}.lock`;
    fs.mkdirSync(lockDir);

    const deletePromise = historyManager.delete(sessionId);
    // Give the lock retry loop time to run while the lock is held.
    await new Promise((r) => setTimeout(r, 150));
    // The session file must still exist — delete is blocked on the lock.
    expect(fs.existsSync(sessionFile)).toBe(true);

    // The in-flight save finishes and releases the lock.
    fs.rmdirSync(lockDir);
    await deletePromise;

    expect(fs.existsSync(sessionFile)).toBe(false);
    const sessions = historyManager.list({});
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(false);
  });

  it("slims promptLogs on save: full blocks collapse, inline base64 images strip", async () => {
    const sessionId = uuidv4();
    // A promptLog as captured at the LLM boundary: the current message's
    // attachment appears as a FULL block, plus an inline base64 image.
    const fatPrompt =
      "<system>sys</system>\n" +
      "<user>see files\n" +
      '<file_content path="/tmp/big.b64">\n' +
      "AAAA....(26MB of base64)\n" +
      "</file_content>\n" +
      "and ![shot](data:image/png;base64,AAAABBBB)</user>\n";
    await historyManager.save({
      sessionId,
      title: "promptlog slimming",
      workspaceDirectory: "ws",
      history: [
        msg("user", "attach please"),
        {
          message: { role: "assistant", content: "done" },
          contextItems: [],
          promptLogs: [
            {
              modelTitle: "m",
              modelProvider: "local",
              prompt: fatPrompt,
              completion: "ok",
            },
          ],
        },
      ],
    });

    const onDisk = readDisk(sessionId);
    const log = onDisk.history[1].promptLogs![0];
    // Body dropped, path kept as the self-closing slimming marker.
    expect(log.prompt).toContain('<file_content path="/tmp/big.b64"/>');
    expect(log.prompt).not.toContain("AAAA....");
    // Inline image reduced to its marker via the existing stripper.
    expect(log.prompt).toContain("![shot]");
    expect(log.prompt).not.toContain("data:image/png;base64");
    // Completion and model metadata are preserved.
    expect(log.completion).toBe("ok");
    expect(log.modelTitle).toBe("m");
  });
});

describe("HistoryManager promptLog delta encoding", () => {
  afterEach(() => {
    historyManager.clearAll();
  });

  it("delta-encodes consecutive promptLogs on save and reconstructs on load", async () => {
    const sessionId = uuidv4();
    // Rolling-context prompts: each round appends to the previous prompt.
    const base = "<system>sys</system>\n" + "X".repeat(20000);
    const p1 = base;
    const p2 = base + "\n<assistant>first answer</assistant>\n";
    const p3 = p2 + "\n<user>follow up</user>\n";
    await historyManager.save({
      sessionId,
      title: "delta test",
      workspaceDirectory: "ws",
      history: [
        msg("user", "q"),
        assistantWithPromptLog("a1", p1),
        assistantWithPromptLog("a2", p2),
        assistantWithPromptLog("a3", p3),
      ],
    });

    const onDisk = readDisk(sessionId);
    const l1 = onDisk.history[1].promptLogs![0];
    const l2 = onDisk.history[2].promptLogs![0];
    const l3 = onDisk.history[3].promptLogs![0];
    // First log has no base: keeps the full prompt.
    expect(l1.prompt).toBe(p1);
    expect(l1.promptDelta).toBeUndefined();
    // Subsequent logs: delta form, middle far smaller than the full prompt.
    expect(l2.prompt).toBeUndefined();
    expect(l2.promptDelta!.middle).toBe(
      "\n<assistant>first answer</assistant>\n",
    );
    expect(l3.promptDelta!.middle).toBe("\n<user>follow up</user>\n");
    // File size win: 3 x 20KB prompts collapse to ~1 full copy + 2 tiny diffs.
    const raw = fs.readFileSync(getSessionFilePath(sessionId), "utf8");
    expect(raw.length).toBeLessThan(p1.length * 2);

    // load() reconstructs full prompts and strips the delta fields.
    const loaded = historyManager.load(sessionId);
    expect(loaded.history[1].promptLogs![0].prompt).toBe(p1);
    expect(loaded.history[2].promptLogs![0].prompt).toBe(p2);
    expect(loaded.history[3].promptLogs![0].prompt).toBe(p3);
    expect(loaded.history[2].promptLogs![0].promptDelta).toBeUndefined();
  });

  it("keeps the full prompt when delta encoding would not save enough", async () => {
    const sessionId = uuidv4();
    // Two prompts with no shared prefix: the diff "middle" is as big as the
    // prompt itself, so the full form must be kept.
    const unrelated1 = "A".repeat(400);
    const unrelated2 = "B".repeat(400);
    await historyManager.save({
      sessionId,
      title: "no-delta test",
      workspaceDirectory: "ws",
      history: [
        msg("user", "q"),
        assistantWithPromptLog("a1", unrelated1),
        assistantWithPromptLog("a2", unrelated2),
      ],
    });

    const onDisk = readDisk(sessionId);
    const l2 = onDisk.history[2].promptLogs![0];
    expect(l2.prompt).toBe(unrelated2);
    expect(l2.promptDelta).toBeUndefined();
  });

  it("degrades to prompt-less logs (no throw) when the delta base is broken", async () => {
    const sessionId = uuidv4();
    const base = "Y".repeat(20000);
    const p1 = base;
    const p2 = base + "\nround1";
    await historyManager.save({
      sessionId,
      title: "broken chain",
      workspaceDirectory: "ws",
      history: [
        msg("user", "q"),
        assistantWithPromptLog("a1", p1),
        assistantWithPromptLog("a2", p2),
      ],
    });

    // Corrupt the file the way an external edit would: drop the message
    // carrying the delta's base prompt.
    const onDisk = readDisk(sessionId);
    onDisk.history.splice(1, 1);
    fs.writeFileSync(
      getSessionFilePath(sessionId),
      JSON.stringify(onDisk, undefined, 2),
    );

    const loaded = historyManager.load(sessionId);
    expect(loaded.history).toHaveLength(2);
    // The orphaned delta cannot be reconstructed: prompt is dropped, but
    // loading must not throw and the chat content is intact.
    expect(loaded.history[1].promptLogs![0].prompt).toBeUndefined();
    expect(loaded.history[1].message.content).toBe("a2");
  });

  it("re-encodes a consistent chain when a lazy tail merges with a delta-encoded disk head", async () => {
    const sessionId = uuidv4();
    const base = "S".repeat(20000);
    const p1 = base;
    const p2 = base + "\nround1";
    const p3 = base + "\nround1\nround2";
    await historyManager.save({
      sessionId,
      title: "lazy merge delta",
      workspaceDirectory: "ws",
      history: [
        msg("user", "u1"),
        assistantWithPromptLog("a1", p1),
        msg("user", "u2"),
        assistantWithPromptLog("a2", p2),
      ],
    });

    // On disk, a2's log is now in delta form.
    const diskBefore = readDisk(sessionId);
    expect(diskBefore.history[3].promptLogs![0].promptDelta).toBeDefined();

    // Lazy-loaded view: the frozen head (4 items, including the delta-form
    // a2) comes from disk; the in-memory tail carries a NEW full-form log.
    await historyManager.save({
      sessionId,
      title: "lazy merge delta",
      workspaceDirectory: "ws",
      history: [assistantWithPromptLog("a3", p3)],
      historyTruncated: true,
      historyLoadedOffset: 4,
    });

    // The merged chain must be re-encoded consistently: load() returns the
    // exact original prompts for all three logs.
    const loaded = historyManager.load(sessionId);
    expect(loaded.history).toHaveLength(5);
    expect(loaded.history[1].promptLogs![0].prompt).toBe(p1);
    expect(loaded.history[3].promptLogs![0].prompt).toBe(p2);
    expect(loaded.history[4].promptLogs![0].prompt).toBe(p3);
    for (const item of loaded.history) {
      for (const log of item.promptLogs ?? []) {
        expect(log.promptDelta).toBeUndefined();
      }
    }
  });

  it("survives deleting a middle assistant message: remaining logs re-diff against the new base", async () => {
    const sessionId = uuidv4();
    const base = "Z".repeat(20000);
    const p1 = base;
    const p2 = base + "\nround1";
    const p3 = base + "\nround1\nround2";
    await historyManager.save({
      sessionId,
      title: "delete middle",
      workspaceDirectory: "ws",
      history: [
        msg("user", "u1"),
        assistantWithPromptLog("a1", p1),
        msg("user", "u2"),
        assistantWithPromptLog("a2", p2),
        msg("user", "u3"),
        assistantWithPromptLog("a3", p3),
      ],
    });

    // GUI deleteMessage path: the in-memory history (full-form prompts, as
    // produced by load()) drops a2's assistant+user pair, then save().
    const inMemory = historyManager.load(sessionId);
    inMemory.history.splice(3, 2);
    await historyManager.save(inMemory);

    // load() must reconstruct the surviving logs exactly — p3 now diffs
    // against p1 (the middle's removal is absorbed into its delta).
    const loaded = historyManager.load(sessionId);
    expect(loaded.history).toHaveLength(4);
    expect(loaded.history[1].promptLogs![0].prompt).toBe(p1);
    expect(loaded.history[3].promptLogs![0].prompt).toBe(p3);
  });

  it("survives edit-and-resend: truncated tail plus a fresh full-form log re-encodes cleanly", async () => {
    const sessionId = uuidv4();
    const base = "W".repeat(20000);
    const p1 = base;
    const p2 = base + "\nround1";
    await historyManager.save({
      sessionId,
      title: "edit resend",
      workspaceDirectory: "ws",
      history: [
        msg("user", "u1"),
        assistantWithPromptLog("a1", p1),
        msg("user", "u2"),
        assistantWithPromptLog("a2", p2),
      ],
    });

    // GUI resumeStream path: load() gives full-form prompts, everything
    // after the edited message is dropped from memory, a new assistant
    // turn appends with a brand-new full prompt.
    const inMemory = historyManager.load(sessionId);
    inMemory.history = inMemory.history.slice(0, 3); // keep u1,a1,u2
    const p2prime = base + "\nround1-EDITED";
    inMemory.history.push(assistantWithPromptLog("a2'", p2prime));
    await historyManager.save(inMemory);

    const loaded = historyManager.load(sessionId);
    expect(loaded.history).toHaveLength(4);
    expect(loaded.history[1].promptLogs![0].prompt).toBe(p1);
    expect(loaded.history[3].promptLogs![0].prompt).toBe(p2prime);
    // The stale pre-edit prompt is gone entirely.
    const allPrompts = loaded.history
      .flatMap((i) => i.promptLogs ?? [])
      .map((l) => l.prompt);
    expect(allPrompts).not.toContain(p2);
  });

  it("edit-and-resend with follow-up rounds: the whole re-forked chain re-encodes exactly", async () => {
    const sessionId = uuidv4();
    const base = "R".repeat(20000);
    const p1 = base;
    const p2 = base + "\nround1";
    const p3 = base + "\nround1\nround2";
    await historyManager.save({
      sessionId,
      title: "edit resend with tail",
      workspaceDirectory: "ws",
      history: [
        msg("user", "u1"),
        assistantWithPromptLog("a1", p1),
        msg("user", "u2"),
        assistantWithPromptLog("a2", p2),
        msg("user", "u3"),
        assistantWithPromptLog("a3", p3),
      ],
    });

    // GUI resumeStream: slice(0, index+1) drops EVERYTHING after the edited
    // message — old p2's AND p3's logs vanish from memory together, then a
    // fresh assistant turn (p2') is appended.
    const inMemory = historyManager.load(sessionId);
    inMemory.history = inMemory.history.slice(0, 3); // keep u1,a1,u2
    const p2prime = base + "\nround1-EDITED";
    inMemory.history.push(assistantWithPromptLog("a2'", p2prime));
    await historyManager.save(inMemory);

    // The conversation continues on the new fork: another round (p3') is
    // streamed and saved (second save on top of a delta-encoded disk file).
    const round2 = historyManager.load(sessionId);
    const p3prime = p2prime + "\nround2-NEW";
    round2.history.push(msg("user", "u3'"));
    round2.history.push(assistantWithPromptLog("a3'", p3prime));
    await historyManager.save(round2);

    // Final load: every prompt on the re-forked chain reconstructs exactly;
    // the old p2/p3 from the abandoned fork are gone entirely.
    const loaded = historyManager.load(sessionId);
    const prompts = loaded.history
      .flatMap((i) => i.promptLogs ?? [])
      .map((l) => l.prompt);
    expect(prompts).toEqual([p1, p2prime, p3prime]);
    expect(prompts).not.toContain(p2);
    expect(prompts).not.toContain(p3);
  });
});

describe("HistoryManager inline-image persistence slimming (regression)", () => {
  afterEach(() => {
    historyManager.clearAll();
  });

  it("strips the duplicate base64 from content.imageUrl when editorState holds the image", async () => {
    const sessionId = uuidv4();
    const base64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5"; // ~48 chars
    await historyManager.save({
      sessionId,
      title: "image slim",
      workspaceDirectory: "ws",
      history: [
        userWithImage("看下这张图", base64, imageEditorState(base64)),
        msg("assistant", "收到"),
      ],
    });

    // 磁盘：base64 载荷只应出现一次（editorState 里），content 里只剩前缀。
    const raw = fs.readFileSync(getSessionFilePath(sessionId), "utf8");
    const occurrences = raw.split(base64).length - 1;
    expect(occurrences).toBe(1);
    const disk = JSON.parse(raw);
    const contentUrl = disk.history[0].message.content[1].imageUrl.url;
    expect(contentUrl).toBe("data:image/jpeg;base64,");
    expect(disk.history[0].editorState.content[0].content[1].attrs.src).toBe(
      `data:image/jpeg;base64,${base64}`,
    );

    // load()：content 的标记保留 "data:" 前缀（构造历史上下文的过滤条件
    // 依赖它），editorState 的完整副本原样还原（渲染/编辑重发的数据源）。
    const loaded = historyManager.load(sessionId);
    const part = (loaded.history[0].message.content as any[])[1];
    expect(part.type).toBe("imageUrl");
    expect(part.imageUrl.url.startsWith("data:")).toBe(true);
    expect(part.imageUrl.url).toBe("data:image/jpeg;base64,");
    expect(loaded.history[0].editorState.content[0].content[1].attrs.src).toBe(
      `data:image/jpeg;base64,${base64}`,
    );
  });

  it("keeps the full base64 when there is no editorState (content is the only copy)", async () => {
    const sessionId = uuidv4();
    const base64 = "WFlaMTIzNDU2Nzg5MDEyMzQ1Njc4OTA=";
    await historyManager.save({
      sessionId,
      title: "no editorState",
      workspaceDirectory: "ws",
      history: [userWithImage("只有 content", base64)],
    });

    const loaded = historyManager.load(sessionId);
    const part = (loaded.history[0].message.content as any[])[1];
    expect(part.imageUrl.url).toBe(`data:image/jpeg;base64,${base64}`);
  });

  it("leaves non-data: image URLs (e.g. https) untouched", async () => {
    const sessionId = uuidv4();
    const url = "https://example.com/cat.png";
    const item = userWithImage(
      "远程图",
      "ignored",
      imageEditorState("ignored"),
    );
    (item.message.content as any[])[1].imageUrl.url = url;
    await historyManager.save({
      sessionId,
      title: "remote image",
      workspaceDirectory: "ws",
      history: [item],
    });

    const loaded = historyManager.load(sessionId);
    const part = (loaded.history[0].message.content as any[])[1];
    expect(part.imageUrl.url).toBe(url);
  });

  it("is idempotent across save/load cycles", async () => {
    const sessionId = uuidv4();
    const base64 = "aXNpbWFnaW5lYmFzZTY0cGF5bG9hZA==";
    await historyManager.save({
      sessionId,
      title: "idempotent",
      workspaceDirectory: "ws",
      history: [userWithImage("x", base64, imageEditorState(base64))],
    });
    // 第二轮：load → 再 save（模拟 GUI 的持续保存），体积与形态不变。
    const first = fs.readFileSync(getSessionFilePath(sessionId), "utf8");
    const reloaded = historyManager.load(sessionId);
    await historyManager.save(reloaded);
    const second = fs.readFileSync(getSessionFilePath(sessionId), "utf8");
    expect(second).toBe(first);
  });

  it("slims legacy fat files on load (migration path)", async () => {
    // 直接落一个“旧版本”文件：content 与 editorState 双份完整 base64。
    const sessionId = uuidv4();
    const base64 = "bGVnYWN5ZGF0YWJhc2U2NGR1cGxpY2F0ZQ==";
    const fat: Session = {
      sessionId,
      title: "legacy fat",
      workspaceDirectory: "ws",
      history: [userWithImage("老文件", base64, imageEditorState(base64))],
    };
    fs.writeFileSync(
      getSessionFilePath(sessionId),
      JSON.stringify(fat),
      "utf8",
    );

    const loaded = historyManager.load(sessionId);
    const part = (loaded.history[0].message.content as any[])[1];
    expect(part.imageUrl.url).toBe("data:image/jpeg;base64,");
    expect(loaded.history[0].editorState.content[0].content[1].attrs.src).toBe(
      `data:image/jpeg;base64,${base64}`,
    );
  });
});
