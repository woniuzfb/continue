import { createAsyncThunk } from "@reduxjs/toolkit";
import { ContextItem } from "core";
import { ThunkApiType } from "../store";
import { findSessionToolCallTarget } from "../util/sessionToolCallWrites";
import { applySessionToolCallUpdate } from "../util/sessionToolCallWrites";
import { continueToolLoop } from "./sessionTools";

/**
 * This thunk is used to move a terminal command to the background
 * when the user clicks the "Move to background" link in the UI
 *
 * It preserves all existing terminal output, marks the command as
 * visually complete, and stops listening to further output from
 * the already running process
 */
export const moveTerminalProcessToBackground = createAsyncThunk<
  void,
  { toolCallId: string },
  ThunkApiType
>(
  "chat/moveTerminalProcessToBackground",
  async ({ toolCallId }, { dispatch, getState, extra }) => {
    // The session must be explicit (方案.md §五.20); the active session is
    // resolved once here because this is a visible-UI action.
    const sessionId = getState().sessions.activeSessionId;
    const session = sessionId
      ? getState().sessions.sessionsById[sessionId]
      : undefined;
    const target = session
      ? findSessionToolCallTarget(session.history, toolCallId)
      : undefined;
    const toolCall = target?.toolCallState;

    if (!sessionId || !session || !target || !toolCall) {
      console.error("Could not find tool call with ID:", toolCallId);
      return;
    }

    // Find existing terminal output to preserve it
    const existingOutput = toolCall.output?.find(
      (item) => item.name === "Terminal",
    );
    const existingContent = existingOutput?.content || "";

    const status =
      "Command moved to background. Further output will be ignored.";

    const contextItems: ContextItem[] = [
      {
        name: "Terminal",
        description: "Terminal command output",
        content: existingContent,
        status: status,
      },
    ];

    // Update the tool call output
    applySessionToolCallUpdate(
      { dispatch, getState },
      {
        sessionId,
        messageId: target.assistantItem.message.id,
        toolCallId,
        patch: { output: contextItems },
      },
    );

    // Mark the process as backgrounded so we ignore future events
    await extra.ideMessenger.request("process/markAsBackgrounded", {
      toolCallId,
    });

    // Mark the tool call as "done" in the UI (isRunning -> false).
    applySessionToolCallUpdate(
      { dispatch, getState },
      {
        sessionId,
        messageId: target.assistantItem.message.id,
        toolCallId,
        patch: { status: "done", output: contextItems },
      },
    );

    // Continue the turn on the same request.
    const requestId =
      getState().sessions.sessionsById[sessionId]?.stream.requestId;
    if (requestId) {
      void dispatch(continueToolLoop({ sessionId, requestId, toolCallId }));
    }
  },
);
