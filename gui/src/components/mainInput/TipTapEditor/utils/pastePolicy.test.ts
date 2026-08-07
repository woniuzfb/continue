import { describe, expect, it } from "vitest";

import { hasRichHtml, shouldUsePlainTextPaste } from "./pastePolicy";

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

describe("hasRichHtml", () => {
  it("detects links, bold, lists, tables, headings, images, quotes, code", () => {
    expect(hasRichHtml('<a href="https://x">link</a>')).toBe(true);
    expect(hasRichHtml("<p><b>bold</b></p>")).toBe(true);
    expect(hasRichHtml("<ul><li>item</li></ul>")).toBe(true);
    expect(hasRichHtml("<table><tr><td>x</td></tr></table>")).toBe(true);
    expect(hasRichHtml("<h2>title</h2>")).toBe(true);
    expect(hasRichHtml('<img src="x.png">')).toBe(true);
    expect(hasRichHtml("<blockquote>q</blockquote>")).toBe(true);
    expect(hasRichHtml("<pre>code</pre>")).toBe(true);
    expect(hasRichHtml("<code>inline</code>")).toBe(true);
  });

  it("treats span/div/p/br-only HTML as NOT rich (VS Code / terminal copies)", () => {
    expect(
      hasRichHtml('<meta charset="utf-8"><div>line1</div><div>line2</div>'),
    ).toBe(false);
    expect(hasRichHtml('<span style="color:red">const x = 1;</span>')).toBe(
      false,
    );
    expect(hasRichHtml("<p>a</p><p></p><p>b</p>")).toBe(false);
    expect(hasRichHtml("")).toBe(false);
  });
});

describe("shouldUsePlainTextPaste", () => {
  it("intercepts plain-text pastes (the empty-line fix must keep working)", () => {
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({ text: "first line\n\nsecond line" }),
      ),
    ).toBe(true);
    // VS Code code copies: span/div-only HTML + text/plain
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({
          html: '<meta charset="utf-8"><div>echo $1</div>',
          text: "echo $1",
        }),
      ),
    ).toBe(true);
  });

  it("lets rich HTML pastes fall through to default handling (formatting preserved)", () => {
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({
          html: "<p>see <a href='https://x'>this</a></p>",
          text: "see this",
        }),
      ),
    ).toBe(false);
    expect(
      shouldUsePlainTextPaste(
        fakeDataTransfer({
          html: "<ul><li>one</li><li>two</li></ul>",
          text: "one\ntwo",
        }),
      ),
    ).toBe(false);
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
