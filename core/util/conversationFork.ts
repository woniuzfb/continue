import { v4 as uuidv4 } from "uuid";
import { ChatHistoryItem, Session } from "..";
import { HistoryManager } from "./history";

export interface ForkConversationParams {
  sessionId: string;
  index: number;
  targetMessageId?: string;
  historyManager: HistoryManager;
}

export function forkConversation({
  sessionId,
  index,
  targetMessageId,
  historyManager,
}: ForkConversationParams): { sessionId: string; title: string } {
  const session = historyManager.load(sessionId);
  let resolvedIndex = index;
  if (
    resolvedIndex < 0 ||
    resolvedIndex >= session.history.length ||
    (targetMessageId &&
      session.history[resolvedIndex]?.message.id !== targetMessageId)
  ) {
    if (targetMessageId) {
      resolvedIndex = session.history.findIndex(
        (item) => item.message.id === targetMessageId,
      );
    }
    if (resolvedIndex < 0 || resolvedIndex >= session.history.length) {
      throw new Error(
        `forkConversation: target index ${index} (messageId=${targetMessageId ?? "none"}) out of bounds (history length=${session.history.length})`,
      );
    }
  }

  const forkedHistory: ChatHistoryItem[] = session.history
    .slice(0, resolvedIndex + 1)
    .map((item) => structuredClone(item));

  for (const item of forkedHistory) {
    for (const tc of item.toolCallStates ?? []) {
      if (
        tc.status === "generating" ||
        tc.status === "generated" ||
        tc.status === "calling"
      ) {
        tc.status = "canceled";
        if (!tc.output || tc.output.length === 0) {
          tc.output = [
            {
              name: `Tool cancelled: ${tc.toolCall.function?.name ?? tc.toolCallId}`,
              description: "Cancelled during conversation fork",
              content: "Tool call cancelled when forking conversation.",
            },
          ];
        }
      }
    }
  }

  const newSessionId = uuidv4();
  const newTitle = session.title ? `${session.title} (Fork)` : "Forked Session";

  const newSession: Session = {
    sessionId: newSessionId,
    title: newTitle,
    workspaceDirectory: session.workspaceDirectory,
    history: forkedHistory,
    mode: session.mode,
    chatModelTitle: session.chatModelTitle,
    ...(session.chatModelRef !== undefined
      ? {
          chatModelRef: session.chatModelRef
            ? { ...session.chatModelRef }
            : session.chatModelRef,
        }
      : {}),
    ...(session.hasReasoningEnabled !== undefined
      ? { hasReasoningEnabled: session.hasReasoningEnabled }
      : {}),
    ...(session.reasoningPreferenceSource !== undefined
      ? { reasoningPreferenceSource: session.reasoningPreferenceSource }
      : {}),
  };

  historyManager.save(newSession);
  return { sessionId: newSessionId, title: newTitle };
}
