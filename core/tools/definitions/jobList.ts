import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const jobListTool: Tool = {
  type: "function",
  displayTitle: "List Background Jobs",
  wouldLikeTo: "list background terminal jobs",
  isCurrently: "listing background terminal jobs",
  hasAlready: "listed background terminal jobs",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.JobList,
    description:
      "List background terminal jobs (both running and recently finished) with their jobId, status, command, exitCode, and elapsed time.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
};
