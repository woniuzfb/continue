import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const jobKillTool: Tool = {
  type: "function",
  displayTitle: "Stop Background Job",
  wouldLikeTo: "stop a running background terminal job",
  isCurrently: "stopping a background terminal job",
  hasAlready: "stopped a background terminal job",
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.JobKill,
    description:
      "Request termination (SIGTERM, then SIGKILL after 5s) of a running background terminal job by its jobId.",
    parameters: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: {
          type: "string",
          description:
            "The job identifier returned by run_terminal_command or job_list (for example, 'job_1').",
        },
        reason: {
          type: "string",
          description: "Optional short reason for stopping the job.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithPermission",
};
