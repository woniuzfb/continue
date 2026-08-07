import { describe, expect, it } from "vitest";

import { replaceSingleDollarOutsideCode } from "./replaceSingleDollarOutsideCode";

describe("replaceSingleDollarOutsideCode", () => {
  it("replaces paired $...$ in plain prose", () => {
    expect(
      replaceSingleDollarOutsideCode("the cost is $5 per unit, total $50."),
    ).toBe("the cost is ＄5 per unit, total ＄50.");
    expect(replaceSingleDollarOutsideCode("Inline math: $x^2 + y^2$")).toBe(
      "Inline math: ＄x^2 + y^2＄",
    );
  });

  it("leaves lone dollar signs in prose unchanged (no pair)", () => {
    // The original regex only ever replaced PAIRED $...$; a single "$5."
    // has no closing $ so it was never touched.
    expect(replaceSingleDollarOutsideCode("The total is $5.")).toBe(
      "The total is $5.",
    );
  });

  it("keeps $ inside fenced code blocks verbatim", () => {
    const input = "```bash\necho $1 $2\nls $(pwd)\n```";
    expect(replaceSingleDollarOutsideCode(input)).toBe(input);
  });

  it("keeps $ inside inline code spans verbatim", () => {
    const input = "Here is inline code `const x = $5 and $10;`";
    expect(replaceSingleDollarOutsideCode(input)).toBe(input);
  });

  it("keeps awk/shell examples in code spans verbatim", () => {
    const input = "awk: `awk -F, '{print $1, $2}'`";
    expect(replaceSingleDollarOutsideCode(input)).toBe(input);
  });

  it("replaces prose $...$ but not code $ in mixed content", () => {
    const input = "cost is $5 and $10. Code: `echo $1 $2`. Total: $50 and $60.";
    expect(replaceSingleDollarOutsideCode(input)).toBe(
      "cost is ＄5 and ＄10. Code: `echo $1 $2`. Total: ＄50 and ＄60.",
    );
  });

  it("keeps an unterminated fence verbatim (CommonMark: code to EOF)", () => {
    const input = "```js\nconst z = $5 and $10;\n// never closed";
    expect(replaceSingleDollarOutsideCode(input)).toBe(input);
  });

  it("keeps tilde fences verbatim (patchNestedMarkdown output)", () => {
    const input = "~~~md\n$foo$ bar\n~~~";
    expect(replaceSingleDollarOutsideCode(input)).toBe(input);
  });

  it("handles fenced blocks followed by prose", () => {
    const input = "```bash\necho $1\n```\nThe total is $5 and $10.";
    expect(replaceSingleDollarOutsideCode(input)).toBe(
      "```bash\necho $1\n```\nThe total is ＄5 and ＄10.",
    );
  });

  it("keeps double-dollar display math untouched (incl. single-line)", () => {
    // $$...$$ is display math: remark-math parses it independently of
    // singleDollarTextMath, so the inline-$ replacement must never touch it.
    expect(replaceSingleDollarOutsideCode("$$x^2 + y^2$$")).toBe(
      "$$x^2 + y^2$$",
    );
    const mixed = "$$x^2 + y^2$$ and inline $a$ and cost $5 and $10.";
    expect(replaceSingleDollarOutsideCode(mixed)).toBe(
      "$$x^2 + y^2$$ and inline ＄a＄ and cost ＄5 and ＄10.",
    );
  });

  it("keeps double-dollar display math inside fenced code verbatim", () => {
    const input = "```tex\n$$\\int_0^1 x\\,dx$$\n```";
    expect(replaceSingleDollarOutsideCode(input)).toBe(input);
  });

  it("returns empty input unchanged", () => {
    expect(replaceSingleDollarOutsideCode("")).toBe("");
  });
});
