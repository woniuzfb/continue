import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * `width: 100%` + a horizontal border or padding is 2px (or 16px) wider than its parent under
 * the default `content-box` sizing.
 *
 * This project cannot lean on a global reset to hide that: `tailwind.config.cjs` sets
 * `preflight: false`, so no stylesheet in the bundle applies `* { box-sizing: border-box }`
 * (verified in `dist/assets/index.css`), and Tailwind's `w-full`/`px-*` utilities are used
 * everywhere. The result was visible: `InputBoxDiv` (`width:100%` + `border:1px`) overflowed the
 * `GradientBorder`'s 1px padding by exactly 2px and covered the right edge of the animated
 * border the user saw as "cut off on the right".
 *
 * The invariant is worth locking structurally, because CSS has no way to tell anyone about it:
 *
 *   any box that declares `width: 100%` / `w-full` **and** a horizontal border or padding
 *   must declare `box-sizing: border-box` (or the `box-border` utility).
 */

const GUI_SRC = join(__dirname, "..");

/** Splits a styled-components file into one chunk per `styled.x` template literal. */
function styledChunks(source: string): string[] {
  const chunks: string[] = [];
  const pattern = /styled\.[a-z]+(?:<[^>]*>)?`([\s\S]*?)`;/g;
  for (const match of source.matchAll(pattern)) {
    chunks.push(match[1]);
  }
  return chunks;
}

const hasHorizontalBoxEdge = (css: string): boolean =>
  // a border on any side but zero, or horizontal padding
  /(^|[\s;])border(-(top|bottom))?\s*:\s*(?!0(?:px)?[;\s])/.test(css) ||
  /(^|[\s;])border-(left|right)\s*:/.test(css) ||
  /(^|[\s;])padding(-(left|right))?\s*:/.test(css);

const declaresBorderBox = (css: string): boolean =>
  /box-sizing:\s*border-box/.test(css);

describe("box model invariant for width:100% containers", () => {
  it("holds for every styled component in the input chain", () => {
    for (const relative of [
      "components/mainInput/GradientBorder.tsx",
      "components/mainInput/TipTapEditor/components/StyledComponents.ts",
    ]) {
      const source = readFileSync(join(GUI_SRC, relative), "utf8");
      const offenders = styledChunks(source).filter(
        (chunk) =>
          /width:\s*100%/.test(chunk) &&
          hasHorizontalBoxEdge(chunk) &&
          !declaresBorderBox(chunk),
      );
      expect(
        offenders.map((chunk) => `${relative}: ${chunk.trim().slice(0, 60)}…`),
      ).toEqual([]);
    }
  });

  it("holds for every JSX className that uses w-full with padding or a border", () => {
    const files = [
      "components/StepContainer/PendingSubmissionItem.tsx",
      "components/mainInput/ContinueInputBox.tsx",
      "components/mainInput/TipTapEditor/TipTapEditor.tsx",
      "pages/gui/Chat.tsx",
    ];
    const offenders: string[] = [];
    for (const relative of files) {
      const source = readFileSync(join(GUI_SRC, relative), "utf8");
      for (const match of source.matchAll(
        /className=(?:"([^"]*)"|\{`([^`]*)`\})/g,
      )) {
        const classes = (match[1] ?? match[2] ?? "").split(/\s+/);
        const fullWidth = classes.includes("w-full");
        const horizontalEdge = classes.some(
          (cls) =>
            /^px-(?!0$)/.test(cls) ||
            (cls.startsWith("border") && cls !== "border-0"),
        );
        if (fullWidth && horizontalEdge && !classes.includes("box-border")) {
          offenders.push(`${relative}: ${classes.join(" ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would catch the regression it was written for", () => {
    // The exact shape that was broken: a styled box with width:100% and a 1px border.
    const broken = `
      width: 100%;
      border: 1px solid red;
    `;
    expect(/width:\s*100%/.test(broken) && hasHorizontalBoxEdge(broken)).toBe(
      true,
    );
    expect(declaresBorderBox(broken)).toBe(false);
    const fixed = `${broken}box-sizing: border-box;`;
    expect(declaresBorderBox(fixed)).toBe(true);
    // …and a class list missing the utility is caught the same way.
    const classes = "bg-input w-full min-w-0 rounded-md px-2 py-1".split(/\s+/);
    expect(
      classes.includes("w-full") &&
        classes.some((cls) => /^px-(?!0$)/.test(cls)) &&
        !classes.includes("box-border"),
    ).toBe(true);
  });
});
