import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const jobOutputTool: Tool = {
  type: "function",
  displayTitle: "Read Background Job Output",
  wouldLikeTo: "read output from a background terminal job",
  isCurrently: "reading output from a background terminal job",
  hasAlready: "read output from a background terminal job",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.JobOutput,
    description:
      "Read incremental output and status from a background terminal job started by run_terminal_command. Returns only new output since the previous read. Set wait=true to wait briefly for new output or completion.",
    parameters: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: {
          type: "string",
          description:
            "The job identifier returned by run_terminal_command or job_list (for example, 'job_1').",
        },
        wait: {
          type: "boolean",
          description:
            "When true, wait up to timeoutMs for new output or job completion before returning. Default is false.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Maximum milliseconds to wait when wait=true (default 10000, max 30000).",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
};
