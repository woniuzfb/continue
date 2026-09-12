import { describe, expect, it } from "vitest";
import { suggestionItemsEqual, tipTapEditorPropsEqual } from "./TipTapEditor";

/**
 * 方案.md §7.5.6：同一长度的不同内容必须重渲染（隐藏窗口尤其如此）。
 *
 * 恢复旧的"只比长度"实现时，本文件第 1、2 条必须变红。
 */

const COMMAND_FOO = { id: "/foo", title: "/foo", description: "foo" };
const COMMAND_BAR = { id: "/bar", title: "/bar", description: "bar" };
const PROVIDER_A = { title: "file", displayTitle: "File" };
const PROVIDER_B = { title: "docs", displayTitle: "Docs" };

function props(overrides: Record<string, unknown> = {}) {
  return {
    editorState: undefined,
    onEnter: () => {},
    inputId: "main-editor-input",
    isMainInput: true,
    placeholder: undefined,
    historyKey: "chat",
    toolbarOptions: {},
    availableContextProviders: [PROVIDER_A],
    availableSlashCommands: [COMMAND_FOO],
    ...overrides,
  } as any;
}

describe("suggestionItemsEqual", () => {
  it("treats the same length with different contents as different", () => {
    expect(suggestionItemsEqual([COMMAND_FOO], [COMMAND_BAR])).toBe(false);
    expect(suggestionItemsEqual([PROVIDER_A], [PROVIDER_B])).toBe(false);
  });

  it("treats an equivalent rebuilt array as equal", () => {
    expect(suggestionItemsEqual([{ ...COMMAND_FOO }], [COMMAND_FOO])).toBe(
      true,
    );
    expect(suggestionItemsEqual([], [])).toBe(true);
    expect(suggestionItemsEqual(undefined, undefined)).toBe(true);
  });

  it("notices a changed length and a missing side", () => {
    expect(suggestionItemsEqual([COMMAND_FOO], [])).toBe(false);
    expect(suggestionItemsEqual([COMMAND_FOO], undefined)).toBe(false);
    expect(suggestionItemsEqual(undefined, [COMMAND_FOO])).toBe(false);
  });
});

describe("tipTapEditorPropsEqual (memo equality)", () => {
  it("re-renders when slash commands change without changing the count", () => {
    // The reported failure: a hidden tab whose command set changed kept serving the old one.
    expect(
      tipTapEditorPropsEqual(
        props({ availableSlashCommands: [COMMAND_FOO] }),
        props({ availableSlashCommands: [COMMAND_BAR] }),
      ),
    ).toBe(false);
  });

  it("re-renders when @ providers change without changing the count", () => {
    expect(
      tipTapEditorPropsEqual(
        props({ availableContextProviders: [PROVIDER_A] }),
        props({ availableContextProviders: [PROVIDER_B] }),
      ),
    ).toBe(false);
  });

  it("does not re-render for an equivalent rebuild or an unrelated change", () => {
    expect(
      tipTapEditorPropsEqual(
        props({ availableSlashCommands: [{ ...COMMAND_FOO }] }),
        props({ availableSlashCommands: [COMMAND_FOO] }),
      ),
    ).toBe(true);
    // Unrelated props still decide equality on their own.
    expect(tipTapEditorPropsEqual(props(), props())).toBe(true);
    expect(
      tipTapEditorPropsEqual(props(), props({ inputId: "other-row" })),
    ).toBe(false);
  });
});
