import { describe, expect, it } from "vitest";
import { suggestionItemsEqual, tipTapEditorPropsEqual } from "./TipTapEditor";

/**
 * 方案.md §7.5.6: the editor must re-read its suggestion sources whenever they are **replaced**.
 *
 * `availableSlashCommandsRef` / `availableContextProviders` are consumed by the suggestion
 * dropdowns (`description`, `content`, `type`, `action`, …), so "same id and title" is not "same
 * behaviour": a command can keep its id/title while its prompt text or action changes, and a
 * provider can keep its title while its configuration changes. The safe boundary is the
 * immutable-array reference the config layer already produces.
 *
 * Restoring either the length-only comparison or the id/title comparison makes the same-id cases
 * below go red.
 */

const COMMAND_FOO = { id: "/foo", title: "/foo", content: "old prompt" };
const PROVIDER_A = { title: "file", displayTitle: "File" };
const COMMANDS = [COMMAND_FOO];
const PROVIDERS = [PROVIDER_A];

function props(overrides: Record<string, unknown> = {}) {
  return {
    editorState: undefined,
    onEnter: () => {},
    inputId: "main-editor-input",
    isMainInput: true,
    placeholder: undefined,
    historyKey: "chat",
    toolbarOptions: {},
    // Deliberately the **same** array references as the default render.
    availableContextProviders: PROVIDERS,
    availableSlashCommands: COMMANDS,
    ...overrides,
  } as any;
}

describe("suggestionItemsEqual", () => {
  it("is reference equality", () => {
    expect(suggestionItemsEqual(COMMANDS, COMMANDS)).toBe(true);
    expect(suggestionItemsEqual(undefined, undefined)).toBe(true);
    expect(suggestionItemsEqual(COMMANDS, [COMMAND_FOO])).toBe(false);
  });
});

describe("tipTapEditorPropsEqual (memo equality)", () => {
  it("does not re-render when both source arrays are the same references", () => {
    expect(tipTapEditorPropsEqual(props(), props())).toBe(true);
  });

  it("re-renders when a command keeps its id but changes its prompt", () => {
    expect(
      tipTapEditorPropsEqual(
        props(),
        props({
          availableSlashCommands: [
            { id: "/foo", title: "/foo", content: "new prompt" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("re-renders when a command keeps its id but changes its action", () => {
    expect(
      tipTapEditorPropsEqual(
        props(),
        props({
          availableSlashCommands: [
            {
              id: "/foo",
              title: "/foo",
              content: "old prompt",
              action: () => {},
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("re-renders when the slash commands are replaced without changing the count", () => {
    expect(
      tipTapEditorPropsEqual(
        props(),
        props({ availableSlashCommands: [{ id: "/bar", title: "/bar" }] }),
      ),
    ).toBe(false);
  });

  it("re-renders when the @ providers are replaced without changing the count", () => {
    expect(
      tipTapEditorPropsEqual(
        props(),
        props({ availableContextProviders: [{ title: "docs" }] }),
      ),
    ).toBe(false);
  });

  it("still compares the unrelated props", () => {
    expect(tipTapEditorPropsEqual(props(), props({ inputId: "row-2" }))).toBe(
      false,
    );
  });
});
