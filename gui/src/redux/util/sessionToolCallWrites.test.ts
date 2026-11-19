import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { patchToolCallStates } from "./sessionToolCallWrites";

function makeAssistantItem(
  status: "generated" | "calling" | "done" | "errored" | "canceled",
): ChatHistoryItemWithMessageId {
  return {
    message: {
      id: "msg-1",
      role: "assistant",
      content: "",
    },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: "tc-edit-1",
        toolCall: {
          id: "tc-edit-1",
          type: "function",
          function: {
            name: "single_find_and_replace",
            arguments:
              '{"filepath":"a.ts","old_string":"old","new_string":"new"}',
          },
        },
        status,
        parsedArgs: { filepath: "a.ts", old_string: "old", new_string: "new" },
        processedArgs: {
          filepath: "a.ts",
          fileUri: "file:///w/a.ts",
          resolvedPath: "file:///w/a.ts",
          old_string: "old",
          new_string: "new",
          editingFileContents: "old full file contents",
          newFileContents: "new full file contents",
        },
      },
    ],
  };
}

describe("patchToolCallStates", () => {
  it("retains editingFileContents and newFileContents while tool call is non-terminal", () => {
    const item = makeAssistantItem("generated");
    const updated = patchToolCallStates(item, "tc-edit-1", {
      status: "calling",
    });
    expect(updated[0].processedArgs?.editingFileContents).toBe(
      "old full file contents",
    );
    expect(updated[0].processedArgs?.newFileContents).toBe(
      "new full file contents",
    );
  });

  it.each(["done", "errored", "canceled"] as const)(
    "strips editingFileContents and newFileContents when transitioning to %s",
    (terminalStatus) => {
      const item = makeAssistantItem("calling");
      const updated = patchToolCallStates(item, "tc-edit-1", {
        status: terminalStatus,
      });
      const processedArgs = updated[0].processedArgs;
      expect(processedArgs).toBeDefined();
      expect(processedArgs?.filepath).toBe("a.ts");
      expect(processedArgs?.fileUri).toBe("file:///w/a.ts");
      expect("editingFileContents" in (processedArgs ?? {})).toBe(false);
      expect("newFileContents" in (processedArgs ?? {})).toBe(false);
    },
  );
});
