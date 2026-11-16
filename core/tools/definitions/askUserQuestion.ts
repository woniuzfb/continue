import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const askUserQuestionTool: Tool = {
  type: "function",
  displayTitle: "Ask User Question",
  wouldLikeTo: "ask you a question",
  isCurrently: "waiting for your answer",
  hasAlready: "received your answer",
  group: BUILT_IN_GROUP_NAME,
  readonly: true,
  isInstant: true,
  defaultToolPolicy: "allowedWithoutPermission",
  function: {
    name: BuiltInToolNames.AskUserQuestion,
    description:
      "Ask the user a concise question with selectable options when you need confirmation, a choice, or missing information before proceeding.",
    parameters: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          description: "Questions to present to the user (1 to 4 questions).",
          items: {
            type: "object",
            required: ["id", "question", "options"],
            properties: {
              id: { type: "string" },
              header: { type: "string" },
              question: { type: "string" },
              multiSelect: { type: "boolean" },
              allowCustom: { type: "boolean" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  required: ["label"],
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
        },
        timeout: {
          type: "number",
          description:
            "Optional timeout in seconds (-1 or omitted for no timeout).",
        },
      },
    },
  },
};
