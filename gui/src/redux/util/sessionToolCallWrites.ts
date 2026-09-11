import { ContextItem, ToolCallState } from "core";
import { renderContextItems } from "core/util/messageContent";
import { toolCallCtxItemToCtxItemWithId } from "core/util/toolCallContextItems";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionHistory";
import { updateHistoryItemByMessageId } from "../slices/sessionsSlice";
import type { AppThunkDispatch, RootState } from "../store";
import { findChatHistoryItemByToolCallId } from "./index";

/**
 * Single write path for `toolCallStates` (方案.md §六 Tool/Compact).
 *
 * Every tool-state mutation goes through `updateHistoryItemByMessageId`,
 * which recomputes `pendingApprovalCount` and invalidates the context metrics
 * snapshot in the same transaction. Tool state must never be written through a
 * bespoke setter, and it must never be read from the active session.
 */

export type SessionToolCallApi = {
  dispatch: AppThunkDispatch;
  getState: () => RootState;
};

export type SessionToolCallTarget = {
  /** The assistant item that owns `toolCallStates`. */
  assistantItem: ChatHistoryItemWithMessageId;
  toolCallState: ToolCallState;
};

export function findSessionToolCallTarget(
  history: ChatHistoryItemWithMessageId[],
  toolCallId: string,
): SessionToolCallTarget | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const assistantItem = history[i];
    const toolCallState = assistantItem.toolCallStates?.find(
      (state) => state.toolCallId === toolCallId,
    );
    if (toolCallState) {
      return { assistantItem, toolCallState };
    }
  }
  return undefined;
}

export function patchToolCallStates(
  item: ChatHistoryItemWithMessageId,
  toolCallId: string,
  patch: Partial<ToolCallState>,
): ToolCallState[] {
  return (item.toolCallStates ?? []).map((state) =>
    state.toolCallId === toolCallId ? { ...state, ...patch } : state,
  );
}

/**
 * Keeps an already-appended tool result message in sync with the tool call
 * output. Before the loop appends the message this is a no-op.
 */
export function syncSessionToolResultMessage(
  { dispatch, getState }: SessionToolCallApi,
  input: { sessionId: string; toolCallId: string; output: ContextItem[] },
): void {
  const session = getState().sessions.sessionsById[input.sessionId];
  const toolItem = session
    ? findChatHistoryItemByToolCallId(session.history, input.toolCallId)
    : undefined;
  if (!toolItem) {
    return;
  }
  dispatch(
    updateHistoryItemByMessageId({
      sessionId: input.sessionId,
      messageId: toolItem.message.id,
      updates: {
        message: {
          ...toolItem.message,
          content: renderContextItems(input.output),
        } as ChatHistoryItemWithMessageId["message"],
        contextItems: input.output.map((item) =>
          toolCallCtxItemToCtxItemWithId(item, input.toolCallId),
        ),
      },
    }),
  );
}

/**
 * Writes one tool call patch for `sessionsById[sessionId]`. Re-reads the item
 * from the store so a concurrent history change cannot be overwritten with a
 * stale snapshot. Returns the item that was written, or `undefined` when the
 * session or the owning message disappeared.
 */
export function applySessionToolCallUpdate(
  api: SessionToolCallApi,
  input: {
    sessionId: string;
    messageId: string;
    toolCallId: string;
    patch: Partial<ToolCallState>;
  },
): ChatHistoryItemWithMessageId | undefined {
  const session = api.getState().sessions.sessionsById[input.sessionId];
  const item = session?.history.find(
    (entry) => entry.message.id === input.messageId,
  );
  if (!item) {
    return undefined;
  }

  api.dispatch(
    updateHistoryItemByMessageId({
      sessionId: input.sessionId,
      messageId: input.messageId,
      updates: {
        toolCallStates: patchToolCallStates(
          item,
          input.toolCallId,
          input.patch,
        ),
      },
    }),
  );

  if (input.patch.output) {
    syncSessionToolResultMessage(api, {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      output: input.patch.output,
    });
  }

  return item;
}
