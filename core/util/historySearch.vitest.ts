import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { v4 as uuidv4 } from "uuid";

// Isolate session storage into a temp dir before anything touches paths.
let tempDir: string;
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-search-"));
  process.env.CONTINUE_GLOBAL_DIR = tempDir;
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

import { ChatHistoryItem } from "..";
import historyManager from "./history";
import { clearHistorySearchCache, searchSessionContent } from "./historySearch";

function msg(role: "user" | "assistant", text: string): ChatHistoryItem {
  return {
    message: { role, content: text },
    contextItems: [],
  };
}

describe("searchSessionContent", () => {
  const alphaId = uuidv4();
  const betaId = uuidv4();

  beforeAll(async () => {
    await historyManager.save({
      sessionId: alphaId,
      title: "Alpha session",
      workspaceDirectory: "/ws/alpha",
      history: [
        msg("user", "How do I parse JSON in TypeScript?"),
        msg("assistant", "You can use JSON.parse, then validate with zod."),
        msg("user", "Thanks, that fixed the token counting bug."),
      ],
    });
    await historyManager.save({
      sessionId: betaId,
      title: "Beta session",
      workspaceDirectory: "/ws/beta",
      history: [
        msg("user", "What is the weather in Shanghai?"),
        msg("assistant", "It is sunny and warm today."),
      ],
    });
  });

  afterAll(() => {
    clearHistorySearchCache();
  });

  it("finds sessions by content, not just title", () => {
    // Neither title contains "zod" — only Alpha's content does
    const results = searchSessionContent("zod");
    expect(results.map((r) => r.sessionId)).toContain(alphaId);
    expect(results.map((r) => r.sessionId)).not.toContain(betaId);
    // Title is still returned so the row renders normally
    const alpha = results.find((r) => r.sessionId === alphaId)!;
    expect(alpha.title).toBe("Alpha session");
    expect(alpha.snippet).toContain("zod");
  });

  it("matches case-insensitively", () => {
    const results = searchSessionContent("SHANGHAI");
    expect(results.map((r) => r.sessionId)).toContain(betaId);
  });

  it("requires ALL tokens to match (AND semantics)", () => {
    const both = searchSessionContent("weather shanghai");
    expect(both.map((r) => r.sessionId)).toEqual([betaId]);
    const none = searchSessionContent("weather alpha");
    expect(none).toEqual([]);
  });

  it("returns newest-first", () => {
    const results = searchSessionContent("the");
    const ids = results.map((r) => r.sessionId);
    // Beta was saved after Alpha; both match "the"
    expect(ids.indexOf(betaId)).toBeLessThan(ids.indexOf(alphaId));
  });

  it("returns [] for empty or whitespace queries", () => {
    expect(searchSessionContent("")).toEqual([]);
    expect(searchSessionContent("   ")).toEqual([]);
  });

  it("respects the workspaceDirectory filter", () => {
    const results = searchSessionContent("the", "/ws/beta");
    expect(results.map((r) => r.sessionId)).toEqual([betaId]);
  });
});
