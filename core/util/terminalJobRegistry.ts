import { ChildProcess } from "node:child_process";

export type TerminalJobStatus = "running" | "completed" | "killed" | "failed";

export interface TerminalJobSnapshot {
  jobId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  status: TerminalJobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  startedAt: number;
  endedAt?: number;
  bufferedChars: number;
  unreadChars: number;
}

export interface TerminalJobReadResult {
  snapshot: TerminalJobSnapshot;
  delta: string;
  truncatedBeforeCursor: boolean;
}

const MAX_BUFFER_CHARS = 2 * 1024 * 1024; // 2M chars ring buffer cap
const MAX_RETAINED_FINISHED_JOBS = 64;
const KILL_GRACE_MS = 5_000;

interface InternalTerminalJob {
  jobId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  process: ChildProcess;
  status: TerminalJobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  startedAt: number;
  endedAt?: number;
  buffer: string;
  droppedChars: number;
  readCursor: number;
  killRequested: boolean;
  sigkillTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (
    process.platform !== "win32" &&
    typeof proc.pid === "number" &&
    proc.pid > 0
  ) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall back to direct child kill if the process is not a group leader
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Ignore if already exited
  }
}

class TerminalJobRegistry {
  private nextSeq = 1;
  private jobs = new Map<string, InternalTerminalJob>();

  register(params: {
    toolCallId: string;
    command: string;
    cwd: string;
    process: ChildProcess;
    initialOutput?: string;
  }): string {
    const jobId = `job_${this.nextSeq++}`;
    const initial = params.initialOutput ?? "";
    const job: InternalTerminalJob = {
      jobId,
      toolCallId: params.toolCallId,
      command: params.command,
      cwd: params.cwd,
      process: params.process,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      buffer: initial,
      droppedChars: 0,
      readCursor: 0,
      killRequested: false,
      waiters: new Set(),
    };
    this.jobs.set(jobId, job);
    this.pruneOldFinished();
    return jobId;
  }

  appendOutput(jobId: string, chunk: string): void {
    if (!chunk) return;
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.buffer += chunk;
    if (job.buffer.length > MAX_BUFFER_CHARS) {
      const excess = job.buffer.length - MAX_BUFFER_CHARS;
      job.buffer = job.buffer.slice(excess);
      job.droppedChars += excess;
    }
    this.notifyWaiters(job);
  }

  markClosed(
    jobId: string,
    code: number | null,
    signal: NodeJS.Signals | null = null,
  ): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.sigkillTimer) {
      clearTimeout(job.sigkillTimer);
      job.sigkillTimer = undefined;
    }
    if (job.status === "running") {
      job.exitCode = code;
      job.signal = signal;
      job.status =
        job.killRequested || signal !== null ? "killed" : "completed";
      job.endedAt = Date.now();
    }
    this.notifyWaiters(job);
    this.pruneOldFinished();
  }

  markFailed(jobId: string, error: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.sigkillTimer) {
      clearTimeout(job.sigkillTimer);
      job.sigkillTimer = undefined;
    }
    if (job.status === "running") {
      job.status = job.killRequested ? "killed" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.endedAt = Date.now();
    }
    this.notifyWaiters(job);
    this.pruneOldFinished();
  }

  getBufferedOutput(jobId: string): string {
    return this.jobs.get(jobId)?.buffer ?? "";
  }

  readDelta(jobId: string): TerminalJobReadResult | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const totalWritten = job.droppedChars + job.buffer.length;
    const truncatedBeforeCursor = job.readCursor < job.droppedChars;
    const effectiveStart = Math.max(job.readCursor, job.droppedChars);
    const sliceOffset = effectiveStart - job.droppedChars;
    const delta = job.buffer.slice(sliceOffset);
    job.readCursor = totalWritten;
    return {
      snapshot: this.toSnapshot(job),
      delta,
      truncatedBeforeCursor,
    };
  }

  async waitForOutputOrExit(
    jobId: string,
    timeoutMs: number,
  ): Promise<TerminalJobReadResult | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const hasUnread = () =>
      job.droppedChars + job.buffer.length > job.readCursor;

    if (job.status !== "running" || hasUnread() || timeoutMs <= 0) {
      return this.readDelta(jobId);
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onWake = () => {
        if (settled) return;
        if (job.status !== "running" || hasUnread()) {
          settled = true;
          if (timer) clearTimeout(timer);
          job.waiters.delete(onWake);
          resolve();
        }
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        job.waiters.delete(onWake);
        resolve();
      }, timeoutMs);
      job.waiters.add(onWake);
    });

    return this.readDelta(jobId);
  }

  kill(jobId: string, reason?: string): TerminalJobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (job.status !== "running") {
      return this.toSnapshot(job);
    }
    job.killRequested = true;
    if (reason) {
      job.error = reason;
    }
    const isStillRunning = () =>
      job.process.exitCode === null && job.process.signalCode === null;

    if (isStillRunning()) {
      killProcessTree(job.process, "SIGTERM");
      if (!job.sigkillTimer) {
        job.sigkillTimer = setTimeout(() => {
          job.sigkillTimer = undefined;
          if (isStillRunning()) {
            killProcessTree(job.process, "SIGKILL");
          }
        }, KILL_GRACE_MS);
      }
    } else {
      this.markClosed(jobId, job.process.exitCode, job.process.signalCode);
    }
    return this.toSnapshot(job);
  }

  getSnapshot(jobId: string): TerminalJobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.toSnapshot(job) : undefined;
  }

  list(): TerminalJobSnapshot[] {
    const all = Array.from(this.jobs.values()).map((j) => this.toSnapshot(j));
    // Running jobs first, then most recently started
    all.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return b.startedAt - a.startedAt;
    });
    return all;
  }

  clearForTests(): void {
    for (const job of this.jobs.values()) {
      if (job.sigkillTimer) {
        clearTimeout(job.sigkillTimer);
        job.sigkillTimer = undefined;
      }
      job.waiters.clear();
    }
    this.jobs.clear();
    this.nextSeq = 1;
  }

  private toSnapshot(job: InternalTerminalJob): TerminalJobSnapshot {
    const totalWritten = job.droppedChars + job.buffer.length;
    return {
      jobId: job.jobId,
      toolCallId: job.toolCallId,
      command: job.command,
      cwd: job.cwd,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      error: job.error,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      bufferedChars: job.buffer.length,
      unreadChars: Math.max(0, totalWritten - job.readCursor),
    };
  }

  private notifyWaiters(job: InternalTerminalJob): void {
    for (const fn of Array.from(job.waiters)) {
      fn();
    }
  }

  private pruneOldFinished(): void {
    const finished = Array.from(this.jobs.values())
      .filter((j) => j.status !== "running")
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    while (finished.length > MAX_RETAINED_FINISHED_JOBS) {
      const oldest = finished.shift();
      if (oldest) {
        this.jobs.delete(oldest.jobId);
      }
    }
  }
}

export const terminalJobRegistry = new TerminalJobRegistry();
