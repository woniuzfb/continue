import { beforeEach, describe, expect, it, vi } from "vitest";
import { processDiff } from "./processDiff";

/**
 * 方案.md §五.21 P3. Accept/reject produces the `closed` event that ends an
 * apply — including edit mode, whose entire stream shares the fixed
 * `EDIT_MODE_STREAM_ID`. That event must name a session, and the two sources
 * are ordered: the caller's explicit sessionId, then the session recorded with
 * the file's diff handler (the request that started the apply). Never the
 * visible session.
 */

vi.mock("vscode", () => ({}));
vi.mock("../extension/EditOutcomeTracker", () => ({
  editOutcomeTracker: { recordEditOutcome: vi.fn() },
}));
vi.mock("core/data/log", () => ({
  DataLogger: { getInstance: vi.fn(() => ({})) },
}));

function makeDeps(handlerSessionId?: string) {
  const requests: Array<{ type: string; payload: any }> = [];
  const verticalDiffManager = {
    clearForfileUri: vi.fn(),
    getStreamIdForFile: vi.fn(() => "edit-mode"),
    getSessionIdForFile: vi.fn(() => handlerSessionId),
  };
  const deps = {
    sidebar: {
      webviewProtocol: {
        request: vi.fn(async (type: string, payload: any) => {
          requests.push({ type, payload });
          return undefined;
        }),
      },
    } as any,
    ide: {
      getCurrentFile: vi.fn(async () => ({ path: "file:///x.ts" })),
      openFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => "const a = 1;"),
      saveFile: vi.fn(async () => {}),
    } as any,
    core: { invoke: vi.fn() } as any,
    verticalDiffManager: verticalDiffManager as any,
  };
  return { ...deps, requests };
}

describe("processDiff session routing (方案.md §五.21 P3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes the apply with the sessionId it was given", async () => {
    const { sidebar, ide, core, verticalDiffManager, requests } = makeDeps();

    await processDiff(
      "accept",
      sidebar,
      ide,
      core,
      verticalDiffManager,
      undefined,
      "edit-mode",
      undefined,
      "s1",
    );

    expect(requests).toEqual([
      {
        type: "updateApplyState",
        payload: expect.objectContaining({
          streamId: "edit-mode",
          status: "closed",
          sessionId: "s1",
        }),
      },
    ]);
  });

  it("falls back to the session recorded with the file's diff handler", async () => {
    const { sidebar, ide, core, verticalDiffManager, requests } =
      makeDeps("s2");

    // The editor code lens / command palette path: no sessionId argument.
    await processDiff(
      "reject",
      sidebar,
      ide,
      core,
      verticalDiffManager,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(verticalDiffManager.getSessionIdForFile).toHaveBeenCalledWith(
      "file:///x.ts",
    );
    expect(requests[0].payload).toMatchObject({
      status: "closed",
      sessionId: "s2",
    });
  });

  it("sends no sessionId when neither source knows one", async () => {
    const { sidebar, ide, core, verticalDiffManager, requests } = makeDeps();

    await processDiff(
      "accept",
      sidebar,
      ide,
      core,
      verticalDiffManager,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(requests[0].payload.sessionId).toBeUndefined();
  });
});
