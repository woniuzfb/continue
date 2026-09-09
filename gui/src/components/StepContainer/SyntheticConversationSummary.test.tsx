import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { createMockStore } from "../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
import { selectSessionById } from "../../redux/selectors/sessions";
import { SyntheticConversationSummary } from "./SyntheticConversationSummary";

function item(
  id: string,
  role: "user" | "assistant",
  content = "",
  conversationSummary?: string,
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
    ...(conversationSummary ? { conversationSummary } : {}),
  } as ChatHistoryItemWithMessageId;
}

const FULL_HISTORY = [
  item("m0", "user", "0"),
  item("m1", "assistant", "1", "compacted"),
  item("m2", "user", "2"),
  item("m3", "assistant", "3"),
  item("m4", "user", "4"),
  item("m5", "assistant", "5"),
];

function makeStore() {
  const runtime = initialSessionRuntime("A", "Chat", {
    // The window only holds the last two items; the carrier (m1) is trimmed.
    history: FULL_HISTORY.slice(4),
    latestConversationSummary: {
      sourceMessageId: "m1",
      sourceAbsoluteIndex: 1,
      content: "compacted",
    },
    pagination: {
      truncated: true,
      loadedOffset: 4,
      totalCount: 6,
      loadedDiskCount: 2,
      hasMore: true,
      loading: false,
      requestGeneration: 0,
      persistPending: false,
    },
  });
  return createMockStore({
    sessions: {
      activeSessionId: "A",
      tabOrder: ["A"],
      tabDescriptors: {
        A: { sessionId: "A", title: "Chat", loadState: "loaded" },
      },
      sessionsById: { A: runtime },
    },
  });
}

describe("SyntheticConversationSummary", () => {
  it("renders the divider and the summary at the head of the window", async () => {
    const store = makeStore();
    await renderWithProviders(<SyntheticConversationSummary />, {
      store: store as any,
    });

    expect(
      screen.getByTestId("synthetic-summary-separator"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Previous Conversation Compacted"),
    ).toBeInTheDocument();
    expect(screen.getByText("Conversation Summary")).toBeInTheDocument();
    expect(screen.getByText("compacted")).toBeInTheDocument();
  });

  it("deletes the compaction by its absolute index", async () => {
    const store = makeStore();
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "A",
      title: "Chat",
      workspaceDirectory: "ws",
      history: FULL_HISTORY,
    } as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    const { user } = await renderWithProviders(
      <SyntheticConversationSummary />,
      { store: store as any },
    );

    await user.click(screen.getByTestId("delete-summary-button"));

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith("history/load", { id: "A" });
    });
    await waitFor(() => {
      const session = selectSessionById(store.getState() as any, "A")!;
      // The carrier is found by absolute index after the full load.
      expect(session.history[1].conversationSummary).toBeUndefined();
      expect(session.latestConversationSummary).toBeUndefined();
    });
  });

  it("renders nothing once the carrier is inside the window", async () => {
    const store = makeStore();
    store.dispatch({
      type: "sessions/setSessionHistory",
      payload: { sessionId: "A", history: FULL_HISTORY },
    });
    store.dispatch({
      type: "sessions/setSessionPagination",
      payload: {
        sessionId: "A",
        pagination: { truncated: false, loadedOffset: 0 },
      },
    });

    const { container } = await renderWithProviders(
      <SyntheticConversationSummary />,
      { store: store as any },
    );

    // The real carrier renders its own summary; the synthetic one is gone.
    expect(
      container.querySelector("[data-testid='synthetic-summary-separator']"),
    ).toBeNull();
  });
});
