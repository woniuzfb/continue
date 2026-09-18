import { cleanup, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "../../../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../../../redux/slices/sessionsSlice";
import { createMockStore } from "../../../util/test/mockStore";
import { renderWithProviders } from "../../../util/test/render";
import { Chat } from "../Chat";

/**
 * 一轮回复以 thinking 结尾时，`Chat` 必须按「本轮末尾」为它挂上 actions 行，
 * 而不是按「整个会话的最后一条」。
 *
 * 用后者时，只要这一轮后面出现任何内容（用户的下一条消息、重载后的窗口），
 * 那一排就永远不再挂载：它在流式刚结束时（当时它确实是最后一条）短暂存在，
 * 之后永久消失。判定依据与 assistant 分支一致 —— 最后一条，或下一条是 user。
 */

function item(
  id: string,
  role: "user" | "assistant" | "thinking",
  content: string,
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content },
    contextItems: [],
  } as ChatHistoryItemWithMessageId;
}

const USER_1 = item("u1", "user", "first question");
const ASSISTANT = item("a1", "assistant", "the reply");
const THINKING = item("t1", "thinking", "the tail thought");
const USER_2 = item("u2", "user", "second question");

function makeStore(
  history: ChatHistoryItemWithMessageId[],
  isStreaming: boolean,
) {
  const runtime = initialSessionRuntime("s1", "Chat 1", {
    history,
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

async function renderThinkingTail(
  history: ChatHistoryItemWithMessageId[],
  isStreaming = false,
): Promise<HTMLElement> {
  const store = makeStore(history, isStreaming);
  await renderWithProviders(<Chat />, { store: store as any });
  const wrapper = document.querySelector('[data-message-id="t1"]');
  expect(wrapper).not.toBeNull();
  return wrapper as HTMLElement;
}

function actionsRow(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector('[data-testid="response-actions-row"]');
}

describe("a reply that ends with a thinking block keeps its actions row", () => {
  it("mounts the row when more history follows the thinking tail", async () => {
    const wrapper = await renderThinkingTail([
      USER_1,
      ASSISTANT,
      THINKING,
      USER_2,
    ]);

    const row = actionsRow(wrapper);
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).queryAllByRole("button").length,
    ).toBeGreaterThan(0);
    cleanup();
  });

  it("mounts the row when the thinking tail ends the session", async () => {
    const wrapper = await renderThinkingTail([USER_1, ASSISTANT, THINKING]);

    const row = actionsRow(wrapper);
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).queryAllByRole("button").length,
    ).toBeGreaterThan(0);
    cleanup();
  });

  it("reserves the row (buttons unmounted) while the thinking tail streams", async () => {
    // 1be7a87c3: the buttons may come and go, the box may not — the streaming
    // state must keep the 36px and only hide the buttons.
    const wrapper = await renderThinkingTail(
      [USER_1, ASSISTANT, THINKING],
      true,
    );

    const row = actionsRow(wrapper);
    expect(row).not.toBeNull();
    expect(row!.className).toContain("h-7");
    expect(row!.className).toContain("opacity-0");
    expect(within(row!).queryAllByRole("button").length).toBe(0);
    cleanup();
  });
});
