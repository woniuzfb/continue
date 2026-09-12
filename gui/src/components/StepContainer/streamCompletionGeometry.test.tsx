import { cleanup, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { renderWithProviders } from "../../util/test/render";
import type { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../../redux/slices/sessionsSlice";
import StepContainer from "./StepContainer";

/**
 * 方案.md §7.2.7: the response-actions row must occupy its 36px (`mt-2` + `h-7`) **before** the
 * stream ends.
 *
 * The row used to be mounted by the same commit that flips `isStreaming` to false — the commit in
 * which the last user bubble also switches from the animated border to the static history style.
 * Growing the transcript at that instant (bottom-pinned scroll) moves every row above the new box,
 * which the user sees as the conversation jumping when the reply finishes. An earlier
 * implementation kept the box mounted precisely for this reason ("We want to occupy space in the
 * DOM regardless of whether the actions are visible to avoid jank on stream complete"); 1c4f983c9
 * removed that, so the invariant is pinned here instead: the buttons may come and go, the box may
 * not.
 */

const USER = {
  message: { id: "u1", role: "user", content: "question" },
  contextItems: [],
} as ChatHistoryItemWithMessageId;

const ASSISTANT = {
  message: { id: "a1", role: "assistant", content: "the reply" },
  contextItems: [],
} as ChatHistoryItemWithMessageId;

function makeStore(isStreaming: boolean) {
  const runtime = initialSessionRuntime("s1", "Chat 1", {
    history: [USER, ASSISTANT],
    ...(isStreaming
      ? { stream: { status: "streaming" as const, requestId: "r1" } }
      : {}),
  });
  return createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
      },
      sessionsById: { s1: runtime },
    },
  });
}

async function renderLastAssistant(isStreaming: boolean) {
  const store = makeStore(isStreaming);
  await renderWithProviders(
    <StepContainer item={ASSISTANT} index={1} isLast={true} />,
    { store: store as any },
  );
  return screen.getByTestId("response-actions-row");
}

describe("the transcript does not resize when a reply finishes", () => {
  it("keeps the response-actions box mounted while the reply is streaming", async () => {
    const row = await renderLastAssistant(true);

    // Same box, same height as the finished state: it is what reserves the space.
    expect(row.className).toContain("h-7");
    expect(row.className).toContain("mt-2");
  });

  it("keeps the row mounted after the reply finishes", async () => {
    const row = await renderLastAssistant(false);
    expect(row.className).toContain("h-7");
    expect(row.className).toContain("mt-2");
  });

  it("mounts the buttons only once the reply finished", async () => {
    // The user bubble keeps its animated border for the whole reply and switches to the static
    // history style together with this flip: nothing else in the commit may change the layout.
    const streamingRow = await renderLastAssistant(true);
    expect(within(streamingRow).queryAllByRole("button")).toEqual([]);
    expect(streamingRow.className).toContain("opacity-0");
    cleanup();

    const finishedRow = await renderLastAssistant(false);
    expect(within(finishedRow).queryAllByRole("button").length).toBeGreaterThan(
      0,
    );
    expect(finishedRow.className).not.toContain("opacity-0");
  });
});
