import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../../util/test/render";
import { createMockStore } from "../../../util/test/mockStore";
import type { ChatHistoryItemWithMessageId } from "../../../redux/slices/sessionHistory";
import { initialSessionRuntime } from "../../../redux/slices/sessionsSlice";
import { SessionViews } from "../../../pages/gui/SessionViews";
import { MAIN_EDITOR_INPUT_ID } from "../../../pages/gui/Chat";
import { TIPPY_DIV_ID, tippyContainerId } from "./utils/tippyContainer";

/**
 * 方案.md §7.3.2: every suggestion popup (`/` slash commands, `@` mentions) is appended into
 * **its own editor's** container, and the container is found by id.
 *
 * The id used to be the single global `TIPPY_DIV_ID`, rendered once per editor instance. Once
 * §九.1/§九.2 started keeping every tab mounted (inactive ones behind `display: none`), one
 * document held one such element per editor of every open tab, and `document.getElementById`
 * returned the first in document order — the first tab's editor. Typing `/` in any other tab
 * appended the menu into a hidden subtree, so nothing appeared at all, and which tab "worked"
 * followed the tab order (reported as "some windows show the slash menu, others do nothing, and
 * I cannot find the pattern").
 *
 * The invariant is therefore: **no two editors share a container id**, and each editor's own
 * container is the one derived from its own session and input.
 */

function item(
  id: string,
  role: "user" | "assistant",
  content: string,
): ChatHistoryItemWithMessageId {
  return {
    message: { id, role, content } as ChatHistoryItemWithMessageId["message"],
    contextItems: [],
  };
}

function twoTabStore() {
  const a = initialSessionRuntime("tab-a", "A", {
    history: [
      item("a-u1", "user", "first session content"),
      item("a-a1", "assistant", "answer a"),
    ],
  });
  const b = initialSessionRuntime("tab-b", "B", {
    history: [
      item("b-u1", "user", "second session content"),
      item("b-a1", "assistant", "answer b"),
    ],
  });
  return createMockStore({
    sessions: {
      activeSessionId: "tab-b",
      tabOrder: ["tab-a", "tab-b"],
      tabDescriptors: {
        "tab-a": { sessionId: "tab-a", title: "A", loadState: "loaded" },
        "tab-b": { sessionId: "tab-b", title: "B", loadState: "loaded" },
      },
      sessionsById: { "tab-a": a, "tab-b": b },
    },
  });
}

describe("suggestion popup containers are per editor (方案.md §7.3.2)", () => {
  it("gives every mounted editor its own container id", async () => {
    const store = twoTabStore();
    await renderWithProviders(<SessionViews />, { store: store as any });

    const containers = Array.from(
      document.querySelectorAll<HTMLElement>(`[id^="${TIPPY_DIV_ID}"]`),
    );
    // One per mounted editor; the history bubbles may render their cached static HTML instead,
    // so only the main editors are guaranteed.
    expect(containers.length).toBeGreaterThanOrEqual(2);

    const ids = containers.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The bare, document-wide id is gone: it is what made the lookup ambiguous.
    expect(document.getElementById(TIPPY_DIV_ID)).toBeNull();
  });

  it("keeps each tab pointing at its own container, including hidden tabs", async () => {
    const store = twoTabStore();
    await renderWithProviders(<SessionViews />, { store: store as any });

    // A tab's editor renders the id that its own suggestion lookup asks for; otherwise the menu
    // lands in another tab's tree again.
    const containerOf = (sessionId: string) =>
      document.getElementById(
        tippyContainerId(sessionId, MAIN_EDITOR_INPUT_ID),
      );
    expect(containerOf("tab-a")).not.toBeNull();
    expect(containerOf("tab-b")).not.toBeNull();
    expect(containerOf("tab-a")).not.toBe(containerOf("tab-b"));

    // tab-a is mounted but not visible (active tab is tab-b): before this fix its container was
    // exactly what `getElementById(TIPPY_DIV_ID)` returned for every tab, which is why a menu
    // opened in tab-b was appended into a hidden subtree and never appeared.
    expect(
      containerOf("tab-a")!.closest('[style*="display: none"]'),
    ).not.toBeNull();
    expect(
      containerOf("tab-b")!.closest('[style*="display: none"]'),
    ).toBeNull();
  });
});
