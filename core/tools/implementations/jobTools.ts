import { ToolImpl } from ".";
import { terminalJobRegistry } from "../../util/terminalJobRegistry";
import { getBooleanArg, getNumberArg, getStringArg } from "../parseArgs";

const DEFAULT_JOB_WAIT_MS = 10_000;
const MAX_JOB_WAIT_MS = 30_000;

function resolveJobIdArg(args: Record<string, unknown>): string {
  const raw =
    (typeof args.jobId === "string" && args.jobId.trim()) ||
    (typeof args.job_id === "string" && args.job_id.trim()) ||
    "";
  if (raw) {
    return raw;
  }
  return getStringArg(args, "jobId");
}

function resolveWaitTimeoutMs(args: Record<string, unknown>): number {
  const raw =
    args.timeoutMs !== undefined
      ? getNumberArg(args, "timeoutMs")
      : args.timeout_ms !== undefined
        ? getNumberArg(args, "timeout_ms")
        : undefined;
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_JOB_WAIT_MS;
  }
  return Math.max(0, Math.min(Math.trunc(raw), MAX_JOB_WAIT_MS));
}

export const jobOutputImpl: ToolImpl = async (args) => {
  const jobId = resolveJobIdArg(args);
  const wait = getBooleanArg(args, "wait", false) ?? false;
  const timeoutMs = resolveWaitTimeoutMs(args);

  const result = wait
    ? await terminalJobRegistry.waitForOutputOrExit(jobId, timeoutMs)
    : terminalJobRegistry.readDelta(jobId);

  if (!result) {
    return [
      {
        name: "Background Job",
        description: `Job ${jobId}`,
        content: `Error: Background job "${jobId}" not found. Use job_list to see available jobs.`,
        status: `Job ${jobId} not found`,
      },
    ];
  }

  const { snapshot, delta, truncatedBeforeCursor } = result;
  const elapsedMs = (snapshot.endedAt ?? Date.now()) - snapshot.startedAt;
  const headerParts = [
    `[jobId: ${snapshot.jobId}]`,
    `[status: ${snapshot.status}]`,
    `[elapsedMs: ${elapsedMs}]`,
  ];
  if (snapshot.exitCode !== null) {
    headerParts.push(`[exit code: ${snapshot.exitCode}]`);
  }
  if (snapshot.signal !== null) {
    headerParts.push(`[signal: ${snapshot.signal}]`);
  }
  if (snapshot.error) {
    headerParts.push(`[error: ${snapshot.error}]`);
  }
  const header = headerParts.join(" ");
  const truncNote = truncatedBeforeCursor
    ? "[Note: earlier output exceeded buffer capacity and was truncated]\n"
    : "";
  const body = delta || "(no new output since previous read)";

  return [
    {
      name: "Background Job",
      description: `Output for ${snapshot.jobId}: ${snapshot.command}`,
      content: `${header}\n${truncNote}${body}`,
      status:
        snapshot.status === "running"
          ? `Job ${snapshot.jobId} is running`
          : `Job ${snapshot.jobId} ${snapshot.status}`,
    },
  ];
};

export const jobListImpl: ToolImpl = async () => {
  const jobs = terminalJobRegistry.list();
  if (jobs.length === 0) {
    return [
      {
        name: "Background Jobs",
        description: "Active and finished background terminal jobs",
        content: "No background terminal jobs recorded in this session.",
        status: "0 background jobs",
      },
    ];
  }

  const lines = jobs.map((j) => {
    const elapsedSec = (
      ((j.endedAt ?? Date.now()) - j.startedAt) /
      1000
    ).toFixed(1);
    const exitPart =
      j.exitCode !== null
        ? ` exitCode=${j.exitCode}`
        : j.signal !== null
          ? ` signal=${j.signal}`
          : "";
    const unreadPart = j.unreadChars > 0 ? ` unreadChars=${j.unreadChars}` : "";
    return `- ${j.jobId} [${j.status}]${exitPart}${unreadPart} (${elapsedSec}s): ${j.command}`;
  });

  return [
    {
      name: "Background Jobs",
      description: "Active and finished background terminal jobs",
      content: lines.join("\n"),
      status: `${jobs.length} background job(s)`,
    },
  ];
};

export const jobKillImpl: ToolImpl = async (args) => {
  const jobId = resolveJobIdArg(args);
  const reason =
    typeof args.reason === "string" && args.reason.trim()
      ? args.reason.trim()
      : undefined;

  const snapshot = terminalJobRegistry.kill(jobId, reason);
  if (!snapshot) {
    return [
      {
        name: "Background Job",
        description: `Stop ${jobId}`,
        content: `Error: Background job "${jobId}" not found.`,
        status: `Job ${jobId} not found`,
      },
    ];
  }

  return [
    {
      name: "Background Job",
      description: `Stop ${snapshot.jobId}`,
      content:
        snapshot.status === "running"
          ? `Termination requested (SIGTERM) for ${snapshot.jobId} (${snapshot.command}).`
          : `Job ${snapshot.jobId} already finished with status=${snapshot.status}.`,
      status: `Termination requested for ${snapshot.jobId}`,
    },
  ];
};
