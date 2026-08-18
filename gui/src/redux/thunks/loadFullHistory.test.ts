import { ChatHistoryItem, Session } from "core";
import { describe, expect, it } from "vitest";

import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { loadFullHistory } from "./loadFullHistory";

/**
 * Regression tests for the loadFullHistory silent-empty-disk guard (P2).
 *
 * historyTruncated=true promises the on-disk file holds at least
 * historyLoadedOffset ("frozen head") items. core's load() returns an EMPTY
 * session (no error) when the file is missing or its JSON is corrupt — before
 * the guard, that empty disk history was merged as a "legal" result:
 *   merged = [] + state.history  →  tail-only context sent to the LLM,
 * and the automatic save after the send OVERWROTE the disk file with the
 * tail-only history, permanently destroying the original.
 *
 * The guard refuses to merge when diskHistory.length < headCount, reusing the
 * existing error path (streamThunkWrapper shows the error dialog and aborts
 * the send).
 */

function item(role: "user" | "assistant", text: string): ChatHistoryItem {
  return { message: { role, content: text }, contextItems: [] };
}

function truncatedState(offset: number, tail: ChatHistoryItem[]) {
  const state = getEmptyRootState() as any;
  state.session.id = "session-guard";
  state.session.history = tail;
  state.session.historyTruncated = true;
  state.session.historyLoadedOffset = offset;
  state.session.hasMoreHistory = true;
  return state;
}

describe("loadFullHistory — silent empty-disk guard (P2)", () => {
  it("REFUSES to merge when the disk history is shorter than the frozen head (file missing → empty session)", async () => {
    // offset claims 5 frozen head items, but load() returned an empty session
    // (the exact shape core returns for a missing/corrupt file).
    const store = createMockStore(
      truncatedState(5, [item("user", "tail-u"), item("assistant", "tail-a")]),
    );
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "session-guard",
      title: "t",
      workspaceDirectory: "ws",
      history: [],
    } satisfies Session;

    const action = store.dispatch(loadFullHistory() as any);
    await expect(
      action.unwrap ? (action as any).unwrap() : action,
    ).rejects.toThrow(/shorter than the expected frozen head/);

    // State must be untouched: no partial merge, truncated flags preserved.
    const s = (store.getState() as any).session;
    expect(s.history).toHaveLength(2);
    expect(s.historyTruncated).toBe(true);
    expect(s.historyLoadedOffset).toBe(5);
  });

  it("REFUSES to merge a corrupt/shortened disk file (history present but < offset)", async () => {
    const store = createMockStore(truncatedState(6, [item("user", "tail-u")]));
    // Disk has *some* history but fewer than the promised 6 head items.
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "session-guard",
      title: "t",
      workspaceDirectory: "ws",
      history: [item("user", "d0"), item("assistant", "d1")],
    } satisfies Session;

    await expect(
      (store.dispatch(loadFullHistory() as any) as any).unwrap(),
    ).rejects.toThrow(/shorter than the expected frozen head/);

    const s = (store.getState() as any).session;
    expect(s.history).toHaveLength(1);
    expect(s.historyTruncated).toBe(true);
  });

  it("still merges normally when the disk history covers the frozen head", async () => {
    const store = createMockStore(
      truncatedState(3, [item("user", "tail-u"), item("assistant", "tail-a")]),
    );
    store.mockIdeMessenger.responses["history/load"] = {
      sessionId: "session-guard",
      title: "t",
      workspaceDirectory: "ws",
      history: [
        item("user", "h0"),
        item("assistant", "h1"),
        item("user", "h2"),
        item("assistant", "h3"), // extra tail-alike item beyond the head
      ],
    } satisfies Session;

    await (store.dispatch(loadFullHistory() as any) as any).unwrap();

    const s = (store.getState() as any).session;
    // head(3) + in-memory tail(2) — the disk item at index 3 is superseded
    // by the (possibly edited) in-memory tail.
    expect(s.history).toHaveLength(5);
    expect(s.history[0].message.content).toBe("h0");
    expect(s.history[2].message.content).toBe("h2");
    expect(s.history[3].message.content).toBe("tail-u");
    expect(s.historyTruncated).toBe(false);
    expect(s.historyLoadedOffset).toBe(0);
  });

  it("is a no-op when history is already fully loaded", async () => {
    const state = getEmptyRootState() as any;
    state.session.id = "session-guard";
    state.session.history = [item("user", "u0")];
    state.session.historyTruncated = false;
    const store = createMockStore(state);

    await (store.dispatch(loadFullHistory() as any) as any).unwrap();

    // No history/load request was made.
    expect(store.mockIdeMessenger.responses["history/load"]).toBeUndefined();
  });
});
