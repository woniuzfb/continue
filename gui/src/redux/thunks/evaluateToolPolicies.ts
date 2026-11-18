import { ToolPolicy } from "@continuedev/terminal-security";
import { MessageModes, Tool, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { isEditTool } from "../../util/toolCallState";
import {
  applySessionToolCallUpdate,
  findSessionToolCallTarget,
} from "../util/sessionToolCallWrites";
import { DEFAULT_TOOL_SETTING, ToolPolicies } from "../slices/uiSlice";
import { AppThunkDispatch, RootState } from "../store";

export interface EvaluatedPolicy {
  policy: ToolPolicy;
  displayValue?: string;
  toolCallState: ToolCallState;
}

const READONLY_SHELL_ALLOWED_BINARIES = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "ag",
  "find",
  "fd",
  "which",
  "whereis",
  "type",
  "stat",
  "file",
  "du",
  "df",
  "echo",
  "printf",
  "date",
  "uname",
  "whoami",
  "id",
  "printenv",
  "diff",
  "cmp",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "tree",
  "realpath",
  "dirname",
  "basename",
  "ps",
  "top",
  "lsof",
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "tag",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "blame",
  "shortlog",
  "describe",
  "remote",
  "config",
  "reflog",
]);

export function isSafeReadonlyShellCommand(rawCommand: unknown): boolean {
  if (typeof rawCommand !== "string") {
    return false;
  }
  if (/[\r\n]/.test(rawCommand)) {
    return false;
  }
  const cmd = rawCommand.trim();
  if (!cmd) {
    return false;
  }
  if (
    /[><`]|\$\(|\bsudo\b|\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bmkdir\b|\btouch\b|\btee\b|\bkill\b|\bpkill\b|\bxargs\b|\bsed\s+-i\b|\bnpm\b|\bpnpm\b|\byarn\b|\bpip\b|\buv\b|\bcargo\b|\bpython3?\b|\bnode\b|\bsh\b|\bbash\b|\bzsh\b|\benv\b|\bawk\b|\byq\b/i.test(
      cmd,
    )
  ) {
    return false;
  }
  const segments = cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  for (const seg of segments) {
    const tokens = seg
      .split(/\s+/)
      .filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (tokens.length === 0) {
      continue;
    }
    const bin = tokens[0].replace(/^\/usr\/bin\/|^\/bin\//, "");
    if (bin === "cd") {
      continue;
    }
    if (bin === "git") {
      let idx = 1;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        if (
          tokens[idx] === "-C" ||
          tokens[idx] === "-c" ||
          tokens[idx] === "--git-dir" ||
          tokens[idx] === "--work-tree"
        ) {
          idx += 2;
        } else {
          idx += 1;
        }
      }
      const sub = tokens[idx] ?? "";
      if (!READONLY_GIT_SUBCOMMANDS.has(sub)) {
        return false;
      }
      if (
        (sub === "branch" || sub === "tag" || sub === "remote") &&
        tokens
          .slice(idx + 1)
          .some(
            (arg) => !arg.startsWith("-") || /^-(d|D|m|M|f|a|s|u)$/.test(arg),
          )
      ) {
        return false;
      }
      if (
        sub === "config" &&
        !tokens
          .slice(idx + 1)
          .some((arg) => ["--get", "--get-all", "--list", "-l"].includes(arg))
      ) {
        return false;
      }
      continue;
    }
    if (!READONLY_SHELL_ALLOWED_BINARIES.has(bin)) {
      return false;
    }
    if (
      bin === "sort" &&
      tokens
        .slice(1)
        .some(
          (arg) =>
            arg === "-o" ||
            arg.startsWith("-o") ||
            arg === "--output" ||
            arg.startsWith("--output="),
        )
    ) {
      return false;
    }
    if (
      bin === "find" &&
      tokens.some((arg) =>
        /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(
          arg,
        ),
      )
    ) {
      return false;
    }
  }
  return true;
}

const WRITE_FILE_TOOLS = new Set<string>([
  BuiltInToolNames.CreateNewFile,
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.SingleFindAndReplace,
  BuiltInToolNames.MultiEdit,
  BuiltInToolNames.CreateRuleBlock,
]);

const READONLY_BUILTIN_TOOLS = new Set<string>([
  BuiltInToolNames.ReadFile,
  BuiltInToolNames.ReadFileRange,
  BuiltInToolNames.ReadCurrentlyOpenFile,
  BuiltInToolNames.GrepSearch,
  BuiltInToolNames.FileGlobSearch,
  BuiltInToolNames.SearchWeb,
  BuiltInToolNames.ViewDiff,
  BuiltInToolNames.LSTool,
  BuiltInToolNames.RequestRule,
  BuiltInToolNames.FetchUrlContent,
  BuiltInToolNames.CodebaseTool,
  BuiltInToolNames.ReadSkill,
  BuiltInToolNames.ViewRepoMap,
  BuiltInToolNames.ViewSubdirectory,
]);

/**
 * Evaluates the tool policy for a tool call, including dynamic policy evaluation
 * Note that tool group policies are not considered here because activeTools already excludes disabled groups
 */
export async function evaluateToolPolicy(
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  toolCallState: ToolCallState,
  toolPolicies: ToolPolicies,
  sessionMode?: MessageModes,
): Promise<EvaluatedPolicy> {
  const effectiveMode = sessionMode === "chat" ? "plan" : sessionMode;
  const toolName = toolCallState.toolCall.function.name;
  const activeTool =
    activeTools.find((tool) => tool.function.name === toolName) ??
    toolCallState.tool;

  const basePolicy: ToolPolicy =
    toolPolicies[toolName] ??
    activeTool?.defaultToolPolicy ??
    DEFAULT_TOOL_SETTING;

  // Rule 1: `disabled` is always the strictest policy — no mode may upgrade it.
  if (basePolicy === "disabled") {
    return { policy: "disabled", toolCallState };
  }

  // Rule 2: Plan (read-only) mode can only tighten, never relax user policy.
  // All file-writing/editing tools and non-readonly tools (except RunTerminalCommand,
  // which must pass the read-only shell guard and still require approval) are strictly disabled.
  const isTerminalTool =
    toolName === BuiltInToolNames.RunTerminalCommand ||
    toolName === "run_terminal_cmd";
  if (effectiveMode === "plan") {
    if (isEditTool(toolName) || WRITE_FILE_TOOLS.has(toolName)) {
      return {
        policy: "disabled",
        displayValue: `${toolName} is disabled in Plan (read-only) mode.`,
        toolCallState,
      };
    }
    if (isTerminalTool) {
      const rawCommand =
        toolCallState.parsedArgs?.command ??
        toolCallState.processedArgs?.command;
      if (!isSafeReadonlyShellCommand(rawCommand)) {
        return {
          policy: "disabled",
          displayValue:
            typeof rawCommand === "string"
              ? `${rawCommand}\n(Plan mode only allows read-only inspection commands; switch to Agent or Full Agent mode to run mutating commands.)`
              : "Mutating terminal commands are disabled in Plan (read-only) mode.",
          toolCallState,
        };
      }
    } else if (toolName !== BuiltInToolNames.AskUserQuestion) {
      if (activeTool) {
        if (!activeTool.readonly) {
          return {
            policy: "disabled",
            displayValue: `${toolName} is disabled in Plan (read-only) mode.`,
            toolCallState,
          };
        }
      } else if (
        activeTools.length > 0 ||
        !READONLY_BUILTIN_TOOLS.has(toolName)
      ) {
        return {
          policy: "disabled",
          displayValue: `${toolName} is disabled in Plan (read-only) mode.`,
          toolCallState,
        };
      }
    }
  }

  // Rule 3: Agent (workspace-write) mode blocks file writes outside the workspace.
  if (effectiveMode === "agent" && WRITE_FILE_TOOLS.has(toolName)) {
    const rawFp = String(
      toolCallState.parsedArgs?.filepath ??
        toolCallState.processedArgs?.filepath ??
        "",
    ).trim();
    const rawResolved = toolCallState.processedArgs?.resolvedPath;
    const resolvedObj =
      typeof rawResolved === "object" && rawResolved !== null
        ? (rawResolved as { uri?: unknown; isWithinWorkspace?: unknown })
        : undefined;
    const resolvedUri = (
      typeof rawResolved === "string"
        ? rawResolved
        : typeof resolvedObj?.uri === "string"
          ? resolvedObj.uri
          : String(toolCallState.processedArgs?.fileUri ?? "")
    ).trim();
    const hasParentTraversal = rawFp
      .replaceAll("\\", "/")
      .split("/")
      .includes("..");
    let isOutsideWorkspace =
      hasParentTraversal ||
      rawFp.startsWith("..") ||
      rawFp.startsWith("~") ||
      rawFp.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(rawFp);
    if (typeof resolvedObj?.isWithinWorkspace === "boolean") {
      isOutsideWorkspace = !resolvedObj.isWithinWorkspace;
    } else if (resolvedUri.startsWith("file://")) {
      const workspaceDirs = await ideMessenger.ide.getWorkspaceDirs();
      isOutsideWorkspace = !workspaceDirs.some((dir) => {
        const normalizedDir = dir.endsWith("/") ? dir : `${dir}/`;
        return resolvedUri === dir || resolvedUri.startsWith(normalizedDir);
      });
    }
    if (isOutsideWorkspace) {
      return {
        policy: "disabled",
        displayValue: `${toolName}(${rawFp || resolvedUri})\n(Agent mode only allows modifying files inside the current workspace; switch to Full Agent mode to modify files outside the workspace.)`,
        toolCallState,
      };
    }
  }

  // Rule 4: Dynamic policy evaluation (cannot be bypassed by any mode).
  const result = await ideMessenger.request("tools/evaluatePolicy", {
    toolName,
    basePolicy,
    parsedArgs: toolCallState.parsedArgs,
    processedArgs: toolCallState.processedArgs,
  });

  if (result.status === "error") {
    console.error(`Error evaluating tool policy for ${toolName}`, result.error);
    return { policy: "disabled", toolCallState };
  }

  const dynamicPolicy = result.content.policy;
  const displayValue = result.content.displayValue;

  if (dynamicPolicy === "disabled") {
    return { policy: "disabled", displayValue, toolCallState };
  }

  if (toolName === BuiltInToolNames.AskUserQuestion) {
    return { policy: "allowedWithoutPermission", displayValue, toolCallState };
  }

  // Edit tools in Agent / Full Agent mode (already verified not disabled and inside workspace for Agent).
  if (isEditTool(toolName)) {
    if (
      toolPolicies[toolName] === "allowedWithPermission" &&
      effectiveMode !== "agent-full"
    ) {
      return { policy: "allowedWithPermission", displayValue, toolCallState };
    }
    return { policy: "allowedWithoutPermission", displayValue, toolCallState };
  }

  // Combine basePolicy and dynamicPolicy: dynamic evaluation cannot make basePolicy more lenient.
  let effectivePolicy: ToolPolicy =
    basePolicy === "allowedWithPermission" &&
    dynamicPolicy === "allowedWithoutPermission"
      ? "allowedWithPermission"
      : dynamicPolicy;

  // Full Agent mode only upgrades "allowedWithPermission" -> "allowedWithoutPermission"
  // after both base and dynamic "disabled" checks have passed.
  if (
    effectiveMode === "agent-full" &&
    effectivePolicy === "allowedWithPermission"
  ) {
    effectivePolicy = "allowedWithoutPermission";
  }

  // Plan mode can only tighten, never relax user policy: terminal commands in Plan mode
  // still require user approval even when they pass the read-only heuristic.
  if (
    effectiveMode === "plan" &&
    isTerminalTool &&
    effectivePolicy === "allowedWithoutPermission"
  ) {
    effectivePolicy = "allowedWithPermission";
  }

  return { policy: effectivePolicy, displayValue, toolCallState };
}

export function policyViolationContextItem(
  toolCallState: ToolCallState,
  displayValue: string | undefined,
) {
  const command = displayValue || toolCallState.toolCall.function.name;
  return {
    icon: "problems",
    name: "Security Policy Violation",
    description: "Command Disabled",
    content: `This command has been disabled by security policy:\n\n${command}\n\nThis command cannot be executed as it may pose a security risk.`,
    hidden: false,
  };
}

/**
 * Phase 1 session-scoped policy evaluation (方案.md §五.20).
 *
 * Tool call states come from `sessionsById[sessionId]`; disabled calls are
 * marked errored through the shared tool-state write path. The returned
 * policies are what the stream runner splits into auto-approved and
 * needs-approval calls.
 */
export async function evaluateSessionToolPolicies(
  api: {
    dispatch: AppThunkDispatch;
    getState: () => RootState;
    ideMessenger: IIdeMessenger;
  },
  input: {
    sessionId: string;
    toolCallIds: string[];
    activeTools: Tool[];
    toolPolicies: ToolPolicies;
  },
): Promise<EvaluatedPolicy[]> {
  const { ideMessenger } = api;
  const { sessionId, toolCallIds, activeTools, toolPolicies } = input;

  const resolved = toolCallIds
    .map((toolCallId) => {
      const session = api.getState().sessions.sessionsById[sessionId];
      const target = session
        ? findSessionToolCallTarget(session.history, toolCallId)
        : undefined;
      return target ? { target, toolCallId } : undefined;
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  const sessionMode = api.getState().sessions.sessionsById[sessionId]?.mode;
  const policyResults = await Promise.all(
    resolved.map(async ({ target, toolCallId }) => {
      const result = await evaluateToolPolicy(
        ideMessenger,
        activeTools,
        target.toolCallState,
        toolPolicies,
        sessionMode,
      );
      if (result.policy === "disabled") {
        applySessionToolCallUpdate(api, {
          sessionId,
          messageId: target.assistantItem.message.id,
          toolCallId,
          patch: {
            status: "errored",
            output: [
              policyViolationContextItem(
                target.toolCallState,
                result.displayValue,
              ),
            ],
          },
        });
      }
      return result;
    }),
  );

  return policyResults;
}
