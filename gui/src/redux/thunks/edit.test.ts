import { beforeEach, describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import type { SetCodeToEditPayload } from "core";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import { createMockStore } from "../../util/test/mockStore";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { lookupApplyOrigin, resetApplyOrigins } from "../util/applyOrigins";
import { streamEditThunk } from "./edit";
import { resetSessionStreamRunner } from "./sessionTools";

const EDITOR_STATE: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "rename this" }],
    },
  ],
};

const CODE_TO_EDIT: SetCodeToEditPayload[] = [
  {
    filepath: "file:///x.ts",
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    contents: "const a = 1;",
  },
];

function makeStore() {
  const s1 = initialSessionRuntime("s1", "Chat 1", { mode: "chat" });
  const s2 = initialSessionRuntime("s2", "Chat 2", { mode: "chat" });
  const store = createMockStore({
    sessions: {
      activeSessionId: "s1",
      tabOrder: ["s1", "s2"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        s2: { sessionId: "s2", title: "Chat 2", loadState: "loaded" },
      },
      sessionsById: { s1, s2 },
    },
  });
  store.mockIdeMessenger.responses = {
    ...store.mockIdeMessenger.responses,
    "edit/sendPrompt": undefined,
  };
  return store;
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<any>;
}

describe("streamEditThunk", () => {
  beforeEach(() => {
    resetApplyOrigins();
    resetSessionStreamRunner();
  });

  /**
   * 方案.md §五.21: edit mode has no tool call, and every session's edit shares
   * the fixed `EDIT_MODE_STREAM_ID`, so the session has to be attached to the
   * request itself. The registry record (P1) is kept alongside it so an old IDE
   * that does not echo the session still works.
   *
   * The edit is started in `s2` while `s1` is the visible tab, so a regression
   * that read the *active* session would be visible here.
   */
  it("records the apply origin before the request that can start a diff stream", async () => {
    const store = makeStore();
    let originWhenRequested: unknown;
    store.mockIdeMessenger.request = vi.fn(async (type: string) => {
      if (type === "edit/sendPrompt") {
        originWhenRequested = lookupApplyOrigin(EDIT_MODE_STREAM_ID);
      }
      return { status: "success", content: undefined, done: true };
    }) as any;
    const request = vi.spyOn(store.mockIdeMessenger, "request");

    await run(
      store,
      streamEditThunk({
        sessionId: "s2",
        editorState: EDITOR_STATE,
        codeToEdit: CODE_TO_EDIT,
      }),
    );

    // P1: the origin exists before the first diff event can arrive.
    expect(originWhenRequested).toEqual({
      kind: "edit",
      sessionId: "s2",
    });
    // P3: and the request carries it, so a new IDE can name the session on
    // every event instead of relying on the registry's single slot.
    expect(request).toHaveBeenCalledWith(
      "edit/sendPrompt",
      expect.objectContaining({ sessionId: "s2" }),
    );
    expect(lookupApplyOrigin(EDIT_MODE_STREAM_ID)).toEqual({
      kind: "edit",
      sessionId: "s2",
    });
  });
});
