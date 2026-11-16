import { ModelDescription, Tool } from "core";
import {
  DEFAULT_AGENT_SYSTEM_MESSAGE,
  DEFAULT_READONLY_SYSTEM_MESSAGE,
} from "core/llm/defaultSystemMessages";
import { getBaseSystemMessage, NO_TOOL_WARNING } from "./getBaseSystemMessage";

const READONLY_SUFFIX = "\n\nCurrent DSH file policy: read-only.";
const WORKSPACE_WRITE_SUFFIX = "\n\nCurrent DSH file policy: workspace-write.";
const FULL_AGENT_SUFFIX =
  "\n\nCurrent DSH file policy: danger-full-access.\nApproval prompts are disabled in this session: eligible tool calls execute without interactive confirmation, while tools or commands explicitly disabled by user or security policy remain blocked.";

test("getBaseSystemMessage should return the correct system message based on mode", () => {
  const mockModel = {
    baseChatSystemMessage: "Custom Chat System Message",
    basePlanSystemMessage: "Custom Plan System Message",
    baseAgentSystemMessage: "Custom Agent System Message",
  } as ModelDescription;

  const mockTool = {
    function: {
      name: "testTool",
      description: "Test tool",
      parameters: {},
    },
  } as Tool;

  // Test agent mode with custom message and tools
  expect(getBaseSystemMessage("agent", mockModel, [mockTool])).toBe(
    "Custom Agent System Message" + WORKSPACE_WRITE_SUFFIX,
  );

  // Test agent-full mode with custom message and tools
  expect(getBaseSystemMessage("agent-full", mockModel, [mockTool])).toBe(
    "Custom Agent System Message" + FULL_AGENT_SUFFIX,
  );

  // Test plan mode with custom message and tools
  expect(getBaseSystemMessage("plan", mockModel, [mockTool])).toBe(
    "Custom Plan System Message" + READONLY_SUFFIX,
  );

  // Test legacy chat mode mapped to plan mode
  expect(getBaseSystemMessage("chat", mockModel, [mockTool])).toBe(
    "Custom Plan System Message" + READONLY_SUFFIX,
  );

  // Test default messages when no custom messages are provided
  expect(
    getBaseSystemMessage("agent", {} as ModelDescription, [mockTool]),
  ).toBe(DEFAULT_AGENT_SYSTEM_MESSAGE + WORKSPACE_WRITE_SUFFIX);
  expect(getBaseSystemMessage("plan", {} as ModelDescription, [mockTool])).toBe(
    DEFAULT_READONLY_SYSTEM_MESSAGE + READONLY_SUFFIX,
  );
  expect(getBaseSystemMessage("chat", {} as ModelDescription, [mockTool])).toBe(
    DEFAULT_READONLY_SYSTEM_MESSAGE + READONLY_SUFFIX,
  );
});

test("getBaseSystemMessage should append no-tools warning when no tools are available", () => {
  const mockModel = {
    baseChatSystemMessage: "Custom Chat System Message",
    basePlanSystemMessage: "Custom Plan System Message",
    baseAgentSystemMessage: "Custom Agent System Message",
  } as ModelDescription;

  // Test agent mode without tools
  expect(getBaseSystemMessage("agent", mockModel, [])).toBe(
    "Custom Agent System Message" + NO_TOOL_WARNING + WORKSPACE_WRITE_SUFFIX,
  );

  // Test plan mode without tools
  expect(getBaseSystemMessage("plan", mockModel, [])).toBe(
    "Custom Plan System Message" + NO_TOOL_WARNING + READONLY_SUFFIX,
  );

  // Test legacy chat mode mapped to plan mode without tools
  expect(getBaseSystemMessage("chat", mockModel, [])).toBe(
    "Custom Plan System Message" + NO_TOOL_WARNING + READONLY_SUFFIX,
  );

  // Test agent mode with undefined tools
  expect(getBaseSystemMessage("agent", mockModel)).toBe(
    "Custom Agent System Message" + NO_TOOL_WARNING + WORKSPACE_WRITE_SUFFIX,
  );

  // Test plan mode with undefined tools
  expect(getBaseSystemMessage("plan", mockModel)).toBe(
    "Custom Plan System Message" + NO_TOOL_WARNING + READONLY_SUFFIX,
  );
});
