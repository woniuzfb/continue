import { renderToStaticMarkup } from "react-dom/server";
import { ServerStyleSheet } from "styled-components";
import { describe, expect, it } from "vitest";
import { GradientBorder } from "./GradientBorder";

/**
 * 方案.md §7.2.7: a box whose **state** changes must not change its **geometry**.
 *
 * The animated→static border switch happens in the same commit that ends the stream, so any
 * layout property that keys off `loading` (or `borderColor`) moves the bubble — and, because the
 * transcript is bottom-pinned, every row above the change — at exactly the moment the user sees
 * the style change. That was a real 8px jump: `margin-top` was applied while `loading`, so a
 * history bubble sat 8px lower for the whole reply and snapped back up when it finished.
 *
 * Source review cannot catch this class of bug (the styling is a template literal, and CSS says
 * nothing when it changes), so the invariant is checked on the CSS the component actually emits:
 * the streaming variant and the resting variant may differ in paint only.
 */

/** Geometry: anything that can move a box or its siblings. */
const LAYOUT_PROPERTY =
  /^(margin|margin-(top|right|bottom|left)|padding|padding-(top|right|bottom|left)|width|min-width|max-width|height|min-height|max-height|border|border-width|border-(top|right|bottom|left)(-width)?|box-sizing|display|position|top|right|bottom|left|inset|flex|flex-(basis|grow|shrink|direction|wrap)|gap|row-gap|column-gap|order|align-(items|self)|justify-content|line-height|font-size|overflow|overflow-(x|y)|white-space|aspect-ratio|border-radius)$/;

/** Renders the component the way the app does and returns the declarations of its own class. */
function emittedDeclarations(node: React.ReactElement): Record<string, string> {
  const sheet = new ServerStyleSheet();
  let html: string;
  let css: string;
  try {
    html = renderToStaticMarkup(sheet.collectStyles(node));
    // `getStyleTags()` wraps everything in `<style …>`; leaving the tag in front of the first
    // selector would make every rule look like it belongs to the `data-styled` registry.
    css = sheet
      .getStyleTags()
      .replace(/<style[^>]*>/g, "")
      .replace(/<\/style>/g, "");
  } finally {
    sheet.seal();
  }

  const classNames = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    match[1].split(/\s+/),
  );

  const declarations: Record<string, string> = {};
  // Only the rules carrying one of this element's classes. Keyframe steps (`0% { … }`) are skipped
  // because their selector is not a class name, and the `data-styled` registry rules are skipped
  // because their `content` lists the generated class name (it "differs" between variants without
  // being a declaration of this element at all).
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1];
    if (selector.includes("data-styled")) {
      continue;
    }
    if (!classNames.some((name) => name && selector.includes(name))) {
      continue;
    }
    for (const declaration of rule[2].split(";")) {
      const separator = declaration.indexOf(":");
      if (separator < 0) {
        continue;
      }
      const property = declaration.slice(0, separator).trim();
      const value = declaration.slice(separator + 1).trim();
      if (property && value) {
        declarations[property] = value;
      }
    }
  }
  return declarations;
}

const layoutOf = (declarations: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(declarations).filter(([property]) =>
      LAYOUT_PROPERTY.test(property),
    ),
  );

const HISTORY_STREAMING = <GradientBorder loading={1} borderRadius="0.5rem" />;
const HISTORY_RESTING = (
  <GradientBorder loading={0} borderColor="#1BBE84" borderRadius="0.5rem" />
);
const MAIN_INPUT_STREAMING = (
  <GradientBorder loading={1} isMainInput borderRadius="0.5rem" />
);
const MAIN_INPUT_RESTING = (
  <GradientBorder
    loading={0}
    borderColor="#1BBE84"
    isMainInput
    borderRadius="0.5rem"
  />
);

describe("the animated border's geometry does not depend on its state", () => {
  it("renders every state of a history bubble with the same layout", () => {
    const historyLayouts = [
      ["streaming a reply", HISTORY_STREAMING],
      ["reply finished (static brand green)", HISTORY_RESTING],
      ["committed, request not started yet", HISTORY_STREAMING],
    ].map(([name, element]) => ({
      name: name as string,
      layout: layoutOf(emittedDeclarations(element as React.ReactElement)),
    }));

    const [first, ...rest] = historyLayouts;
    // Non-vacuity guard: if extraction silently returned nothing, every comparison below would
    // pass on empty objects.
    const properties = Object.keys(first.layout).sort();
    expect(properties).toContain("box-sizing");
    expect(properties).toContain("padding");
    expect(properties).toContain("width");
    expect(properties.length).toBeGreaterThanOrEqual(8);

    for (const variant of rest) {
      expect(
        variant.layout,
        `${variant.name} differs in layout from a streaming bubble`,
      ).toEqual(first.layout);
    }
  });

  it("never lets a history bubble pick up the main input's 8px gap", () => {
    // The gap belongs to the main input: on a history bubble it used to be applied while the
    // reply streamed, which moved the bubble (and every row below it) by 8px and moved it back
    // in the commit that ended the reply. `margin-top: ""` is dropped by styled-components, so
    // "absent" is the resting state this asserts.
    for (const element of [HISTORY_STREAMING, HISTORY_RESTING]) {
      expect(emittedDeclarations(element)["margin-top"]).toBeUndefined();
    }
    // The main input keeps its own behaviour untouched (its `loading` can only be set while
    // editing during a live stream).
    expect(emittedDeclarations(MAIN_INPUT_STREAMING)["margin-top"]).toBe("8px");
    expect(
      emittedDeclarations(MAIN_INPUT_RESTING)["margin-top"],
    ).toBeUndefined();
  });

  it("only ever varies paint properties between states", () => {
    const streaming = emittedDeclarations(HISTORY_STREAMING);
    const resting = emittedDeclarations(HISTORY_RESTING);

    const differing = Object.keys({ ...streaming, ...resting }).filter(
      (property) => streaming[property] !== resting[property],
    );
    expect(differing.sort()).toEqual([
      "-webkit-animation",
      "animation",
      "background",
    ]);
  });
});
