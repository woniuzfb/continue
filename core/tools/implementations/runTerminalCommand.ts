import iconv from "iconv-lite";
import childProcess from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ToolImpl } from ".";
import {
  isProcessBackgrounded,
  markProcessAsBackgrounded,
  markProcessAsRunning,
  removeBackgroundedProcess,
  removeRunningProcess,
  updateProcessOutput,
} from "../../util/processTerminalStates";
import { terminalJobRegistry } from "../../util/terminalJobRegistry";
import { getBooleanArg, getNumberArg, getStringArg } from "../parseArgs";

// Default foreground wait timeout before auto-promoting to a background job (120s, aligned with voiceedge-harness)
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MIN_TOOL_TIMEOUT_MS = 1_000;
const MAX_TOOL_TIMEOUT_MS = 300_000;

// Automatically decode the buffer according to the platform to avoid garbled Chinese
function getDecodedOutput(data: Buffer): string {
  if (process.platform === "win32") {
    try {
      let out = iconv.decode(data, "utf-8");
      if (/\uFFFD/.test(out)) {
        out = iconv.decode(data, "gbk");
      }
      return out;
    } catch {
      return iconv.decode(data, "gbk");
    }
  } else {
    return data.toString();
  }
}

// Simple helper function to use login shell on Unix/macOS and PowerShell on Windows
function getShellCommand(command: string): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    // Windows: Use PowerShell
    return {
      shell: "powershell.exe",
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  } else {
    // Unix/macOS: Use login shell to source .bashrc/.zshrc etc.
    const userShell = process.env.SHELL || "/bin/bash";
    return { shell: userShell, args: ["-l", "-c", command] };
  }
}

function resolveForegroundTimeoutMs(args: Record<string, unknown>): number {
  const raw =
    args.timeoutMs !== undefined
      ? getNumberArg(args, "timeoutMs")
      : args.timeout_ms !== undefined
        ? getNumberArg(args, "timeout_ms")
        : undefined;
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_TOOL_TIMEOUT_MS;
  }
  return Math.max(
    MIN_TOOL_TIMEOUT_MS,
    Math.min(Math.trunc(raw), MAX_TOOL_TIMEOUT_MS),
  );
}

/**
 * Resolves the working directory from workspace dirs.
 * Falls back to home directory or temp directory if no workspace is available.
 */
function resolveWorkingDirectory(workspaceDirs: string[]): string {
  // Handle file:// URIs (local workspaces)
  const fileWorkspaceDir = workspaceDirs.find((dir) =>
    dir.startsWith("file:/"),
  );
  if (fileWorkspaceDir) {
    try {
      return fileURLToPath(fileWorkspaceDir);
    } catch {
      // fileURLToPath can fail on malformed URIs or in some remote environments
      // Fall through to default handling
    }
  }

  // Handle other URI schemes (vscode-remote://wsl, vscode-remote://ssh-remote, etc.)
  const remoteWorkspaceDir = workspaceDirs.find(
    (dir) => dir.includes("://") && !dir.startsWith("file:/"),
  );
  if (remoteWorkspaceDir) {
    try {
      const url = new URL(remoteWorkspaceDir);
      return decodeURIComponent(url.pathname);
    } catch {
      // Fall through to other handlers
    }
  }

  // Default to user's home directory with fallbacks
  try {
    return process.env.HOME || process.env.USERPROFILE || process.cwd();
  } catch {
    // Final fallback if even process.cwd() fails - use system temp directory
    return os.tmpdir();
  }
}

// Add color-supporting environment variables
const getColorEnv = () => ({
  ...process.env,
  FORCE_COLOR: "1",
  COLORTERM: "truecolor",
  TERM: "xterm-256color",
  CLICOLOR: "1",
  CLICOLOR_FORCE: "1",
});

// Only spawn processes locally when there is no remote workspace.
// With extensionKind: ["ui", "workspace"], the extension host almost always
// runs on the local machine. childProcess.spawn() executes on the extension
// host, so for any remote workspace it would run commands on the wrong machine
// (or fail with ENOENT when the local shell doesn't match the remote OS).
// All remote types delegate to ide.runCommand() which routes through VS Code's
// integrated terminal and executes in the correct remote environment.
const LOCAL_ONLY = ["", "local"];

function formatPromotedNotice(jobId: string, timeoutMs: number): string {
  return (
    `\n[still running after ${timeoutMs}ms; moved to background job ${jobId}]\n` +
    `Use job_output(jobId="${jobId}", wait=true) to poll incremental output, ` +
    `job_list() to check status, or job_kill(jobId="${jobId}") to terminate.`
  );
}

function formatStartedBackgroundNotice(jobId: string): string {
  return (
    `Command is running in the background (${jobId}). ` +
    `Use job_output(jobId="${jobId}", wait=true) to poll incremental output, ` +
    `job_list() to check status, or job_kill(jobId="${jobId}") to terminate.`
  );
}

export const runTerminalCommandImpl: ToolImpl = async (args, extras) => {
  const command = getStringArg(args, "command");
  // Default to waiting for completion if not specified
  const waitForCompletion =
    getBooleanArg(args, "waitForCompletion", false) ?? true;
  const foregroundTimeoutMs = resolveForegroundTimeoutMs(args);

  const ideInfo = await extras.ide.getIdeInfo();
  const toolCallId = extras.toolCallId || "";

  if (LOCAL_ONLY.includes(ideInfo.remoteName)) {
    const workspaceDirs = await extras.ide.getWorkspaceDirs();
    const cwd = resolveWorkingDirectory(workspaceDirs);
    const hasStreaming = Boolean(extras.onPartialOutput);

    return new Promise((resolve, reject) => {
      let terminalOutput = "";
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let promotedToBackground = false;
      let settled = false;

      const finishResolve = (items: Awaited<ReturnType<ToolImpl>>) => {
        if (settled) return;
        settled = true;
        resolve(items);
      };

      const finishReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      // Use spawn with color environment; create a dedicated process group on POSIX so job_kill stops child trees
      const { shell, args: shellArgs } = getShellCommand(command);
      const childProc = childProcess.spawn(shell, shellArgs, {
        cwd,
        env: getColorEnv(),
        ...(process.platform !== "win32" ? { detached: true } : {}),
      });

      const jobId = terminalJobRegistry.register({
        toolCallId,
        command,
        cwd,
        process: childProc,
      });

      // Track this process for foreground cancellation
      if (toolCallId && waitForCompletion) {
        markProcessAsRunning(
          toolCallId,
          childProc,
          extras.onPartialOutput,
          terminalOutput,
        );
      }

      if (!waitForCompletion && hasStreaming && extras.onPartialOutput) {
        extras.onPartialOutput({
          toolCallId,
          contextItems: [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: "",
              status: `Command is running in the background (${jobId})...`,
            },
          ],
        });
      }

      const isRunning = () =>
        childProc.exitCode === null && childProc.signalCode === null;

      // Foreground wait timeout: align with voiceedge-harness promoteOnTimeout.
      // Instead of killing the process, promote it to a tracked background job
      // and immediately hand back the jobId + output captured so far.
      if (waitForCompletion) {
        timeoutId = setTimeout(() => {
          timeoutId = undefined;
          if (!isRunning() || settled) {
            return;
          }
          promotedToBackground = true;
          if (toolCallId) {
            removeRunningProcess(toolCallId);
            markProcessAsBackgrounded(toolCallId);
          }
          // Advance the job's read cursor so subsequent job_output calls only return new output.
          const snap = terminalJobRegistry.readDelta(jobId);
          const captured = snap?.delta ?? terminalOutput;
          const handoffContent = `${captured}${formatPromotedNotice(jobId, foregroundTimeoutMs)}`;

          if (extras.onPartialOutput) {
            extras.onPartialOutput({
              toolCallId,
              contextItems: [
                {
                  name: "Terminal",
                  description: "Terminal command output",
                  content: handoffContent,
                  status: `Running in background (${jobId})...`,
                },
              ],
            });
          }

          finishResolve([
            {
              name: "Terminal",
              description: "Terminal command output",
              content: handoffContent,
              status: `Command moved to background (${jobId})`,
            },
          ]);
        }, foregroundTimeoutMs);
      }

      const handleData = (data: Buffer, isStderr: boolean) => {
        const newOutput = getDecodedOutput(data);
        terminalJobRegistry.appendOutput(jobId, newOutput);

        // If user manually backgrounded or timeout promoted this job, keep
        // buffering in terminalJobRegistry without mutating foreground UI state.
        if (promotedToBackground || isProcessBackgrounded(toolCallId)) {
          return;
        }

        terminalOutput += newOutput;

        if (toolCallId && waitForCompletion) {
          updateProcessOutput(toolCallId, terminalOutput);
        }

        if (extras.onPartialOutput) {
          const item: {
            name: string;
            description: string;
            content: string;
            status?: string;
          } = {
            name: "Terminal",
            description: "Terminal command output",
            content: terminalOutput,
          };
          if (!isStderr) {
            item.status = waitForCompletion
              ? ""
              : `Command is running in the background (${jobId})...`;
          }
          extras.onPartialOutput({
            toolCallId,
            contextItems: [item],
          });
        }
      };

      childProc.stdout?.on("data", (data: Buffer) => handleData(data, false));
      childProc.stderr?.on("data", (data: Buffer) => handleData(data, true));

      // If we don't need to wait for completion, resolve immediately with jobId
      if (!waitForCompletion) {
        const status = `Command is running in the background (${jobId})...`;
        const content = terminalOutput
          ? `${terminalOutput}\n${formatStartedBackgroundNotice(jobId)}`
          : formatStartedBackgroundNotice(jobId);
        // Advance read cursor for any initial output already returned
        terminalJobRegistry.readDelta(jobId);
        finishResolve([
          {
            name: "Terminal",
            description: "Terminal command output",
            content,
            status,
          },
        ]);
      }

      childProc.on("close", (code, signal) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }

        terminalJobRegistry.markClosed(jobId, code, signal);

        const wasManuallyBackgrounded =
          Boolean(toolCallId) && isProcessBackgrounded(toolCallId);
        if (toolCallId) {
          if (wasManuallyBackgrounded) {
            removeBackgroundedProcess(toolCallId);
          }
          removeRunningProcess(toolCallId);
        }

        if (promotedToBackground || !waitForCompletion) {
          if (extras.onPartialOutput) {
            const status =
              code === 0 || !code
                ? `\nBackground command completed (${jobId})`
                : `\nBackground command failed with exit code ${code} (${jobId})`;
            const fullOutput =
              terminalJobRegistry.getBufferedOutput(jobId) || terminalOutput;
            extras.onPartialOutput({
              toolCallId,
              contextItems: [
                {
                  name: "Terminal",
                  description: "Terminal command output",
                  content: fullOutput,
                  status,
                },
              ],
            });
          }
          return;
        }

        if (wasManuallyBackgrounded) {
          return;
        }

        // Consume buffered output so job_output doesn't duplicate completed foreground output
        terminalJobRegistry.readDelta(jobId);

        if (!code || code === 0) {
          finishResolve([
            {
              name: "Terminal",
              description: "Terminal command output",
              content: terminalOutput,
              status: "Command completed",
            },
          ]);
        } else {
          const failStatus = hasStreaming
            ? `Command failed with exit code ${code}`
            : `Command failed with: Command failed with exit code ${code}`;
          finishResolve([
            {
              name: "Terminal",
              description: "Terminal command output",
              content: terminalOutput,
              status: failStatus,
            },
          ]);
        }
      });

      childProc.on("error", (error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }

        terminalJobRegistry.markFailed(jobId, error);

        if (toolCallId) {
          if (isProcessBackgrounded(toolCallId)) {
            removeBackgroundedProcess(toolCallId);
            return;
          }
          removeRunningProcess(toolCallId);
        }

        if (promotedToBackground || !waitForCompletion) {
          return;
        }

        if (hasStreaming) {
          finishReject(error);
        } else {
          const status = `Command failed with: ${error.message || error.toString()}`;
          finishResolve([
            {
              name: "Terminal",
              description: "Terminal command output",
              content: error.toString(),
              status,
            },
          ]);
        }
      });
    });
  }

  // For remote environments (SSH, WSL, Dev Container, Codespaces, etc.),
  // delegate to VS Code's integrated terminal which handles remote execution.
  // Note: output capture and waitForCompletion are not yet supported for remotes.
  await extras.ide.runCommand(command);
  return [
    {
      name: "Terminal",
      description: "Terminal command output",
      content:
        "Command executed in remote terminal. Output capture is not yet available for remote environments.",
      status: "Command executed",
    },
  ];
};
