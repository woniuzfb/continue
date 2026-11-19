import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDE, ToolExtras } from "../..";
import { clearAllBackgroundProcesses } from "../../util/processTerminalStates";
import { terminalJobRegistry } from "../../util/terminalJobRegistry";
import { jobKillImpl, jobListImpl, jobOutputImpl } from "./jobTools";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  runTerminalCommandImpl,
} from "./runTerminalCommand";

// Hoist mock function so it can be referenced in vi.mock factory
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  default: {
    spawn: mockSpawn,
  },
  spawn: mockSpawn,
}));

describe("runTerminalCommand promoteOnTimeout & background jobs", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockChildProc: any;
  let mockGetIdeInfo: ReturnType<typeof vi.fn>;
  let mockGetWorkspaceDirs: ReturnType<typeof vi.fn>;
  let mockOnPartialOutput: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setTimeoutSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let clearTimeoutSpy: any;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.clearAllTimers();
    vi.useFakeTimers();
    terminalJobRegistry.clearForTests();
    clearAllBackgroundProcesses();

    setTimeoutSpy = vi.spyOn(global, "setTimeout");
    clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    mockChildProc = new EventEmitter();
    mockChildProc.stdout = new EventEmitter();
    mockChildProc.stderr = new EventEmitter();
    mockChildProc.exitCode = null;
    mockChildProc.signalCode = null;
    mockChildProc.killed = false;
    mockChildProc.kill = vi.fn((signal?: NodeJS.Signals) => {
      mockChildProc.killed = true;
      setTimeout(() => {
        mockChildProc.exitCode = signal === "SIGKILL" ? 137 : 143;
        mockChildProc.signalCode = signal ?? null;
        mockChildProc.emit("close", mockChildProc.exitCode, signal ?? null);
      }, 100);
      return true;
    });

    mockSpawn.mockReturnValue(mockChildProc);

    mockGetIdeInfo = vi.fn().mockResolvedValue({ remoteName: "local" });
    mockGetWorkspaceDirs = vi
      .fn()
      .mockResolvedValue(["file:///tmp/test-workspace"]);
    mockOnPartialOutput = vi.fn();
  });

  afterEach(() => {
    terminalJobRegistry.clearForTests();
    clearAllBackgroundProcesses();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const createMockExtras = (
    overrides: Partial<ToolExtras> = {},
  ): ToolExtras => {
    const mockIde = {
      getIdeInfo: mockGetIdeInfo,
      getWorkspaceDirs: mockGetWorkspaceDirs,
      getIdeSettings: vi.fn(),
      getDiff: vi.fn(),
      readFile: vi.fn(),
      readRangeInFile: vi.fn(),
      isTelemetryEnabled: vi.fn(),
      getProblems: vi.fn(),
      subprocess: vi.fn(),
      getWorkspaceConfigs: vi.fn(),
      showToast: vi.fn(),
      listWorkspaceContents: vi.fn(),
      getTerminalContents: vi.fn(),
      listFolders: vi.fn(),
      getSessionId: vi.fn(),
      runCommand: vi.fn(),
      showLines: vi.fn(),
      saveFile: vi.fn(),
      getBranch: vi.fn(),
      showDiff: vi.fn(),
      getOpenFiles: vi.fn(),
      showVirtualFile: vi.fn(),
      openFile: vi.fn(),
      getRepo: vi.fn(),
      pathSep: vi.fn(),
      fileExists: vi.fn(),
    } as unknown as IDE;

    return {
      ide: mockIde,
      llm: {} as any,
      fetch: vi.fn() as any,
      tool: {} as any,
      config: {} as any,
      onPartialOutput: mockOnPartialOutput,
      toolCallId: "test-tool-call-id",
      ...overrides,
    };
  };

  it("should set up default foreground promote timeout when waitForCompletion is true", async () => {
    const extras = createMockExtras();
    const args = { command: "echo test", waitForCompletion: true };
    const resultPromise = runTerminalCommandImpl(args, extras);
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_TOOL_TIMEOUT_MS,
    );
    mockChildProc.exitCode = 0;
    mockChildProc.emit("close", 0, null);
    const result = await resultPromise;
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(result[0].status).toBe("Command completed");
  });

  it("should NOT set up foreground promote timeout when waitForCompletion is false and returns a jobId", async () => {
    const extras = createMockExtras();
    const args = { command: "sleep 10", waitForCompletion: false };
    const result = await runTerminalCommandImpl(args, extras);
    const timeoutCalls = setTimeoutSpy.mock.calls.filter(
      (call: any[]) => call[1] === DEFAULT_TOOL_TIMEOUT_MS,
    );
    expect(timeoutCalls.length).toBe(0);
    expect(result[0].status).toContain("background");
    expect(result[0].content).toContain("job_1");
  });

  it("should promote process to background on timeout without killing it and stream incremental output via job_output", async () => {
    const extras = createMockExtras();
    const args = {
      command: "pnpm test",
      waitForCompletion: true,
      timeoutMs: 5_000,
    };
    const resultPromise = runTerminalCommandImpl(args, extras);
    await vi.advanceTimersByTimeAsync(0);

    // Emit initial output before timeout
    mockChildProc.stdout.emit("data", Buffer.from("phase 1 output\n"));

    // Trigger promoteOnTimeout (5s)
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    // Must NOT kill the process
    expect(mockChildProc.kill).not.toHaveBeenCalled();
    expect(result[0].status).toContain("background");
    expect(result[0].content).toContain("phase 1 output");
    expect(result[0].content).toContain("moved to background job job_1");

    // Subsequent output while running in background
    mockChildProc.stdout.emit("data", Buffer.from("phase 2 output\n"));
    const poll1 = await jobOutputImpl({ jobId: "job_1" }, extras);
    expect(poll1[0].content).toContain("[status: running]");
    expect(poll1[0].content).toContain("phase 2 output");
    expect(poll1[0].content).not.toContain("phase 1 output");

    // Process exits later
    mockChildProc.stdout.emit("data", Buffer.from("done!\n"));
    mockChildProc.exitCode = 0;
    mockChildProc.emit("close", 0, null);

    // Final UI partial output must include output captured after promotion
    const lastPartialCall =
      mockOnPartialOutput.mock.calls[mockOnPartialOutput.mock.calls.length - 1];
    expect(lastPartialCall[0].contextItems[0].content).toContain(
      "phase 2 output",
    );
    expect(lastPartialCall[0].contextItems[0].content).toContain("done!");

    const poll2 = await jobOutputImpl({ jobId: "job_1" }, extras);
    expect(poll2[0].content).toContain("[status: completed]");
    expect(poll2[0].content).toContain("[exit code: 0]");
    expect(poll2[0].content).toContain("done!");
  });

  it("should kill the full POSIX process group when pid is present", async () => {
    if (process.platform === "win32") return;
    const extras = createMockExtras();
    mockChildProc.pid = 43210;
    const processKillSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as unknown as typeof process.kill);

    await runTerminalCommandImpl(
      { command: "sleep 300", waitForCompletion: false },
      extras,
    );

    await jobKillImpl({ jobId: "job_1" }, extras);
    expect(processKillSpy).toHaveBeenCalledWith(-43210, "SIGTERM");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(processKillSpy).toHaveBeenCalledWith(-43210, "SIGKILL");
  });

  it("should support job_list and job_kill with graceful SIGTERM and SIGKILL fallback", async () => {
    const extras = createMockExtras();
    const args = { command: "sleep 300", waitForCompletion: false };
    await runTerminalCommandImpl(args, extras);

    const listed = await jobListImpl({}, extras);
    expect(listed[0].content).toContain("job_1 [running]");
    expect(listed[0].content).toContain("sleep 300");

    // Override kill so process ignores SIGTERM until SIGKILL
    mockChildProc.kill = vi.fn((signal?: NodeJS.Signals) => {
      mockChildProc.killed = true;
      if (signal === "SIGKILL") {
        mockChildProc.exitCode = 137;
        mockChildProc.signalCode = "SIGKILL";
        mockChildProc.emit("close", 137, "SIGKILL");
      }
      return true;
    });

    const killRes = await jobKillImpl(
      { jobId: "job_1", reason: "no longer needed" },
      extras,
    );
    expect(killRes[0].content).toContain("Termination requested (SIGTERM)");
    expect(mockChildProc.kill).toHaveBeenCalledWith("SIGTERM");

    // After 5s grace period, SIGKILL fires
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockChildProc.kill).toHaveBeenCalledWith("SIGKILL");

    const poll = await jobOutputImpl({ jobId: "job_1" }, extras);
    expect(poll[0].content).toContain("[status: killed]");
  });

  it("should clear timeout on normal process exit", async () => {
    const extras = createMockExtras();
    const args = { command: "echo quick", waitForCompletion: true };
    const resultPromise = runTerminalCommandImpl(args, extras);
    await vi.advanceTimersByTimeAsync(0);
    mockChildProc.stdout.emit("data", Buffer.from("quick\n"));
    mockChildProc.exitCode = 0;
    mockChildProc.emit("close", 0, null);
    await resultPromise;
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(mockChildProc.kill).not.toHaveBeenCalled();
  });
});
