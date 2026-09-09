import { describe, expect, it } from "vitest";
import {
  migratePersistedStateToV2,
  normalizePersistedSessionsState,
} from "./persistV2";

describe("migratePersistedStateToV2", () => {
  it("maps a v1 snapshot (tabs + session) into the v2 projection", () => {
    const v2 = migratePersistedStateToV2({
      session: {
        id: "s-active",
        lastSessionId: "s-last",
        title: "Active title",
        mode: "chat",
      },
      tabs: {
        tabs: [
          { id: "t1", title: "Chat 1", isActive: false, sessionId: "s1" },
          {
            id: "t2",
            title: "Active title",
            isActive: true,
            sessionId: "s-active",
          },
        ],
      },
      editModeState: {
        returnToMode: "edit",
        lastNonEditSessionWasEmpty: true,
        codeToEdit: [],
        applyState: { streamId: "x", status: "done" },
      },
    });

    expect(v2.sessions.tabOrder).toEqual(["s1", "s-active"]);
    expect(v2.sessions.activeSessionId).toBe("s-active");
    expect(v2.sessionCatalog.lastSessionId).toBe("s-last");
    expect(v2.sessions.tabDescriptors["s-active"].loadState).toBe("unloaded");
    expect(v2.sessions.tabDescriptors["s1"].persistedEditState).toEqual({
      returnToMode: "edit",
      lastNonEditSessionWasEmpty: true,
      codeToEdit: [],
    });
    // Runtime-only apply state must not survive.
    expect(
      (v2.sessions.tabDescriptors["s1"] as any).persistedEditState.applyState,
    ).toBeUndefined();
  });

  it("handles the v0 shape: a single tab without sessionId", () => {
    const v2 = migratePersistedStateToV2({
      session: { id: "s0", title: "Chat 1" },
      tabs: { tabs: [{ id: "t1", title: "Chat 1", isActive: true }] },
    });

    expect(v2.sessions.tabOrder).toEqual(["s0"]);
    expect(v2.sessions.activeSessionId).toBe("s0");
    expect(v2.sessionCatalog.lastSessionId).toBe("s0");
  });

  it("dedupes repeated session ids and ignores empty ones", () => {
    const v2 = migratePersistedStateToV2({
      session: { id: "s1" },
      tabs: {
        tabs: [
          { id: "t1", title: "A", isActive: false, sessionId: "s1" },
          { id: "t2", title: "B", isActive: false, sessionId: "s1" },
          { id: "t3", title: "C", isActive: false, sessionId: "" },
        ],
      },
    });

    expect(v2.sessions.tabOrder).toEqual(["s1"]);
  });
});

describe("normalizePersistedSessionsState", () => {
  it("drops descriptors outside tabOrder, dedupes and resets loadState", () => {
    const normalized = normalizePersistedSessionsState({
      sessions: {
        activeSessionId: "s3",
        tabOrder: ["s1", "s1", "s2", "ghost"],
        tabDescriptors: {
          s1: {
            sessionId: "s1",
            title: "One",
            loadState: "loaded",
          },
          s2: {
            sessionId: "s2",
            title: "Two",
            loadState: "loading",
          },
          ghost: {
            sessionId: "ghost",
            title: "Ghost",
            loadState: "loaded",
          },
          // Not listed in tabOrder -> must be dropped.
          orphan: {
            sessionId: "orphan",
            title: "Orphan",
            loadState: "loaded",
          },
        },
      },
      sessionCatalog: { lastSessionId: "s2" },
    });

    expect(normalized.sessions.tabOrder).toEqual(["s1", "s2", "ghost"]);
    expect(Object.keys(normalized.sessions.tabDescriptors)).toEqual([
      "s1",
      "s2",
      "ghost",
    ]);
    expect(normalized.sessions.tabDescriptors.s1.loadState).toBe("unloaded");
    expect(normalized.sessions.tabDescriptors.s2.loadState).toBe("unloaded");
    // activeSessionId must point at a real tab; falls back to the last one.
    expect(normalized.sessions.activeSessionId).toBe("ghost");
    expect(normalized.sessionCatalog.lastSessionId).toBe("s2");
  });

  it("produces an empty, tab-less state when nothing was persisted", () => {
    const normalized = normalizePersistedSessionsState({
      sessions: {
        activeSessionId: undefined,
        tabOrder: [],
        tabDescriptors: {},
      },
      sessionCatalog: {},
    });

    expect(normalized.sessions.activeSessionId).toBeUndefined();
    expect(normalized.sessions.tabOrder).toEqual([]);
    expect(normalized.sessions.tabDescriptors).toEqual({});
  });
});
