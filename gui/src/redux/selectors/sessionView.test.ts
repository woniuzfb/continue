import { describe, expect, it } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import {
  selectActiveCodeBlockApplyStates,
  selectActiveCompactionLoading,
  selectActiveHasMoreHistory,
  selectActiveHistory,
  selectActiveHistoryTruncated,
  selectActiveFullConversationMetrics,
  selectActiveIsStreaming,
  selectActiveMainEditorDraft,
  selectActiveMode,
  selectActiveSessionId,
  selectActiveTitle,
  selectAllSessionMetadata,
  selectLastSessionId,
} from "./sessionView";

function item(id: string, content = "hi") {
  return {
    message: { id, role: "user", content } as any,
    contextItems: [],
  };
}

/**
 * The view selectors must prefer the runtime and fall back to the legacy slice
 * while the writers are still migrating.
 */
describe("sessionView selectors", () => {
  it("prefers the runtime when one exists", () => {
    const store = createMockStore({
      sessions: {
        activeSessionId: "s1",
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "Runtime", loadState: "loaded" },
        },
        sessionsById: {
          s1: initialSessionRuntime("s1", "Runtime", {
            history: [item("r1", "runtime")],
            mode: "agent",
            stream: { status: "streaming", requestId: "req-1" },
            pagination: {
              truncated: true,
              loadedOffset: 4,
              hasMore: true,
              loading: false,
              requestGeneration: 0,
              persistPending: false,
            },
          }),
        },
      },
    });

    const state = store.getState() as any;
    expect(selectActiveSessionId(state)).toBe("s1");
    expect(selectActiveTitle(state)).toBe("Runtime");
    expect(selectActiveHistory(state)[0].message.content).toBe("runtime");
    expect(selectActiveMode(state)).toBe("agent");
    expect(selectActiveIsStreaming(state)).toBe(true);
    expect(selectActiveHistoryTruncated(state)).toBe(true);
    expect(selectActiveHasMoreHistory(state)).toBe(true);
  });

  it("returns stable empty values when no runtime exists", () => {
    const store = createMockStore({
      sessions: {
        activeSessionId: undefined,
        tabOrder: [],
        tabDescriptors: {},
        sessionsById: {},
      },
    });
    const state = store.getState() as any;

    expect(selectActiveSessionId(state)).toBe("");
    expect(selectActiveTitle(state)).toBe("");
    expect(selectActiveHistory(state)).toEqual([]);
    expect(selectActiveMode(state)).toBe("chat");
    expect(selectActiveIsStreaming(state)).toBe(false);
    // Stage 2E: the legacy per-field projection is gone; the metrics projection is
    // selected per session instead (`selectFullConversationMetrics`).
    expect(selectActiveFullConversationMetrics(state)).toBeUndefined();
    // Stable references: useSelector must not see a new array each call.
    expect(selectActiveHistory(state)).toBe(selectActiveHistory(state));
  });

  it("reads compaction loading by messageId from the runtime and by index from legacy", () => {
    const runtimeStore = createMockStore({
      sessions: {
        activeSessionId: "s1",
        tabOrder: ["s1"],
        tabDescriptors: {
          s1: { sessionId: "s1", title: "S", loadState: "loaded" },
        },
        sessionsById: {
          s1: initialSessionRuntime("s1", "S", {
            compactionLoading: { m1: true },
          }),
        },
      },
    });
    const runtimeState = runtimeStore.getState() as any;
    expect(selectActiveCompactionLoading(runtimeState, "m1")).toBe(true);
    expect(selectActiveCompactionLoading(runtimeState, "m2")).toBe(false);
  });

  it("prefers the catalog slice and keeps other fields reachable", () => {
    const store = createMockStore({
      sessionCatalog: {
        allSessionMetadata: [
          {
            sessionId: "s1",
            title: "From catalog",
            dateCreated: "2026-01-01T00:00:00.000Z",
            workspaceDirectory: "/w",
          },
        ],
        lastSessionId: "s1",
        isLoading: false,
      },
    });
    const state = store.getState() as any;

    expect(selectLastSessionId(state)).toBe("s1");
    expect(selectAllSessionMetadata(state)).toHaveLength(1);
    expect(selectActiveMainEditorDraft(state)).toBeUndefined();
    expect(selectActiveCodeBlockApplyStates(state)).toEqual({
      states: [],
      curIndex: 0,
    });
  });
});
