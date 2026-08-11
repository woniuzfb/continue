import { describe, expect, it } from "vitest";

import { shouldUsePlainTextPaste } from "./pastePolicy";

function fakeDataTransfer(opts: {
  items?: { kind: string; type: string }[];
  html?: string;
  text?: string;
}): Pick<DataTransfer, "items" | "getData"> {
  const { items = [], html, text } = opts;
  return {
    items: items as unknown as DataTransferItemList,
    getData: (type: string) => {
      if (type === "text/html") return html ?? "";
      if (type === "text/plain") return text ?? "";
      return "";
    },
  };
}

describe("shouldUsePlainTextPaste", () => {
  it("intercepts plain-text pastes (markdown symbols + blank lines preserved)", () => {
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({ text: "first line\n\nsecond line" }),
      ),
    ).toBe(true);
  });

  it("intercepts rich HTML pastes too - the chat schema has no formatting nodes", () => {
    // Rendered web HTML (bold/headings/lists) would be flattened to text by
    // the schema anyway, so the markdown source in text/plain must win.
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({
          html: "<p><b>bold</b></p><h2>heading</h2><ul><li>item</li></ul>",
          text: "**bold**\n\n## heading\n\n* item",
        }),
      ),
    ).toBe(true);
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({
          html: "<table><tr><td>a</td></tr></table>",
          text: "| a |",
        }),
      ),
    ).toBe(true);
  });

  it("intercepts VS Code / terminal copies (span/div-highlighted text)", () => {
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({
          html: '<meta charset="utf-8"><div><span>echo $1</span></div>',
          text: "echo $1",
        }),
      ),
    ).toBe(true);
  });

  it("lets image file pastes fall through to the Image extension", () => {
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({
          items: [{ kind: "file", type: "image/png" }],
          text: "",
        }),
      ),
    ).toBe(false);
  });

  it("does not intercept when there is nothing usable", () => {
    expect(shouldUsePlainTextPaste(fakeDataTransfer({}))).toBe(false);
    expect(
      shouldUsePlainTextPaste(fakeDataTransfer({ html: "<div></div>" })),
    ).toBe(false);
  });
});
