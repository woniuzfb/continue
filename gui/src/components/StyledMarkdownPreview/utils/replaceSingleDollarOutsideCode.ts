/**
 * Fenced code blocks (``` or ~~~, with optional language tag) and inline code
 * spans (`...`). remark-math only treats `$...$` in TEXT nodes as math — code
 * nodes are never math — so dollar signs inside code must be preserved
 * verbatim. Only plain-text `$...$` is a math candidate that needs
 * neutralization when inline LaTeX rendering is disabled.
 *
 * Fences are line-anchored (CommonMark: up to 3 leading spaces), and the
 * closing fence must use the same character and be line-anchored too.
 * An unterminated fence extends to end-of-input (CommonMark: unclosed code
 * blocks run to EOF), so `$` inside it is also preserved.
 */
const CODE_SEGMENT_RE =
  /(?:^|\n)[ \t]{0,3}(```|~~~)[^\n]*(?:\n|$)[\s\S]*?(?:(?:^|\n)[ \t]{0,3}\1[ \t]*(?:\n|$)|$)|`[^`\n]*`/g;

/**
 * Single-dollar math delimiter pair: opening $ must not be preceded or
 * followed by another $, and closing $ must not be preceded or followed by
 * another $. This excludes `$$...$$` (display math) entirely — remark-math
 * parses double-dollar blocks independently of singleDollarTextMath, so they
 * must be left untouched.
 */
const SINGLE_DOLLAR_PAIR_RE = /(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g;

/**
 * Replace single-$ delimiters with fullwidth dollar signs (＄) ONLY outside
 * code spans/fences. When inline LaTeX rendering is disabled
 * (`renderInlineLatex: false`), this prevents remark-math from parsing
 * `$...$` in prose as math — while keeping `$` in code blocks / inline code
 * intact so displayed code is not corrupted.
 */
export function replaceSingleDollarOutsideCode(source: string): string {
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  CODE_SEGMENT_RE.lastIndex = 0;
  while ((m = CODE_SEGMENT_RE.exec(source)) !== null) {
    result += source
      .slice(last, m.index)
      .replace(SINGLE_DOLLAR_PAIR_RE, "＄$1＄");
    result += m[0]; // code segment kept verbatim
    last = m.index + m[0].length;
  }
  result += source.slice(last).replace(SINGLE_DOLLAR_PAIR_RE, "＄$1＄");
  return result;
}
