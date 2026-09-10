import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplyManager } from "./ApplyManager";

/**
 * 方案.md §五.21 P3. The IDE is the only side that can name the GUI session on
 * a diff-stream event, because the event itself has none: it must come from the
 * request that started the apply and be echoed on every event for that apply.
 * These tests pin that threading — a `sessionId` that stops at `applyToFile`
 * would silently leave every event unowned again.
 *
 * `vi.hoisted` because `vi.mock` is hoisted above the module body: the mock
 * factory cannot close over values that are initialized later.
 */
const h = vi.hoisted(() => {
  const activeTextEditor = {
    document: {
      getText: vi.fn(() => "existing file contents"),
      lineCount: 1,
      lineAt: vi.fn(() => ({ text: "" })),
      uri: { toString: () => "file:///x.ts" },
    },
    selection: { isEmpty: true },
    edit: vi.fn(async () => true),
  };
  return { activeTextEditor };
});

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: h.activeTextEditor,
    showErrorMessage: vi.fn(),
  },
  Position: class {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  },
  Range: class {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
  Selection: class {},
  commands: { executeCommand: vi.fn() },
  workspace: { onDidChangeTextDocument: vi.fn() },
}));

function makeManager() {
  const requests: Array<{ type: string; payload: any }> = [];
  const webviewProtocol = {
    request: vi.fn(async (type: string, payload: any) => {
      requests.push({ type, payload });
      return undefined;
    }),
  };
  const verticalDiffManager = {
    instantApplyDiff: vi.fn(async () => {}),
    streamDiffLines: vi.fn(async () => {}),
    streamEdit: vi.fn(async () => {}),
  };
  const configHandler = { loadConfig: vi.fn(async () => ({ config: null })) };
  const manager = new ApplyManager(
    {} as any,
    webviewProtocol as any,
    verticalDiffManager as any,
    configHandler as any,
  );
  return { manager, requests, verticalDiffManager };
}

describe("ApplyManager session threading (方案.md §五.21 P3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("echoes the sessionId on every event of an apply", async () => {
    const { manager, requests } = makeManager();
    h.activeTextEditor.document.getText.mockReturnValue("");

    await manager.applyToFile({
      streamId: "stream-1",
      text: "new contents",
      toolCallId: "t1",
      sessionId: "s1",
    });

    expect(requests.map((r) => r.type)).toEqual([
      "updateApplyState",
      "updateApplyState",
    ]);
    expect(requests[0].payload).toMatchObject({
      streamId: "stream-1",
      status: "streaming",
      toolCallId: "t1",
      sessionId: "s1",
    });
    // The immediate close of an empty document must name the session too.
    expect(requests[1].payload).toMatchObject({
      streamId: "stream-1",
      status: "closed",
      sessionId: "s1",
    });
  });

  it("carries the sessionId into the vertical diff manager", async () => {
    const { manager, verticalDiffManager } = makeManager();
    h.activeTextEditor.document.getText.mockReturnValue("existing contents");

    await manager.applyToFile({
      streamId: "stream-2",
      text: "replacement",
      sessionId: "s2",
      isSearchAndReplace: true,
    });

    expect(verticalDiffManager.instantApplyDiff).toHaveBeenCalledWith(
      "existing contents",
      "replacement",
      "stream-2",
      undefined,
      "s2",
    );
  });

  it("omits the sessionId for a request that does not name one", async () => {
    const { manager, requests } = makeManager();
    h.activeTextEditor.document.getText.mockReturnValue("");

    await manager.applyToFile({ streamId: "stream-3", text: "x" });

    for (const { payload } of requests) {
      expect(payload.sessionId).toBeUndefined();
    }
  });
});
