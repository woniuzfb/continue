import {
  replaceFileContentBlocks,
  stripInlineImageBase64,
} from "./messageContent.js";

/**
 * Regression tests for the file-attachment / inline-image helpers used by
 * token counting (countTokens.ts). These lock down two real bugs:
 *
 *  P2-1: `replaceFileContentBlocks` must line-anchor the OPENING <file_content>
 *        tag (not just the closing tag). Otherwise a mid-line mention of the
 *        literal string "<file_content path=...>" inside ordinary prose starts
 *        a greedy span that swallows everything up to the next standalone
 *        </file_content> line. This mirrors the server-side parser
 *        (_CLINE_FILE_CONTENT_RE in voice_edge.py), which anchors BOTH tags.
 *
 *  stripInlineImageBase64: must use paren-depth tracking so a data URL whose
 *        base64 payload happens to contain ")" is still stripped correctly.
 */
describe("messageContent attachment helpers (regression)", () => {
  describe("replaceFileContentBlocks — line-anchored opening tag (P2-1)", () => {
    it("collapses a real block that occupies its own lines", () => {
      const input =
        "Files attached by the user:\n\n" +
        '<file_content path="src/a.py">\n' +
        "print('hello')\n" +
        "</file_content>\n";
      expect(replaceFileContentBlocks(input)).toBe(
        "Files attached by the user:\n\n[file: src/a.py]",
      );
    });

    it("does NOT collapse an inline (mid-line) mention in prose", () => {
      // The user is *discussing* the marker; it appears mid-line, not on its
      // own line. Before the fix, the greedy regex matched from here all the
      // way to the real closing tag below, corrupting the token estimate.
      const input =
        'A real block looks like <file_content path="x.py"> inline here.\n' +
        "Then, on its own line, the real attachment:\n" +
        '<file_content path="real.py">\n' +
        "CODE\n" +
        "</file_content>\n";
      const out = replaceFileContentBlocks(input);
      // The inline mention survives verbatim…
      expect(out).toContain('<file_content path="x.py"> inline here.');
      // …and only the standalone block is collapsed.
      expect(out).toContain("[file: real.py]");
      expect(out).not.toContain("CODE");
    });

    it("collapses multiple consecutive blocks independently", () => {
      const input =
        '<file_content path="a.js">\nA\n</file_content>\n\n' +
        '<file_content path="b.js">\nB\n</file_content>\n';
      const out = replaceFileContentBlocks(input);
      expect(out).toContain("[file: a.js]");
      expect(out).toContain("[file: b.js]");
      expect(out).not.toContain("A\n");
      expect(out).not.toContain("B\n");
    });

    it("supports single-quoted and bare path attribute values", () => {
      const single = "<file_content path='sp aced.py'>\nX\n</file_content>\n";
      expect(replaceFileContentBlocks(single)).toBe("[file: sp aced.py]");
      const bare = "<file_content path=bare.py>\nY\n</file_content>\n";
      expect(replaceFileContentBlocks(bare)).toBe("[file: bare.py]");
    });

    it("falls back to [file] when no path attribute is present", () => {
      const input = "<file_content>\nZ\n</file_content>\n";
      expect(replaceFileContentBlocks(input)).toBe("[file]");
    });

    it("returns empty/undefined-safe input unchanged", () => {
      expect(replaceFileContentBlocks("")).toBe("");
    });
  });

  describe("stripInlineImageBase64 — paren-depth tracking", () => {
    it("strips a data URL payload, keeping only the ![alt] marker", () => {
      const input =
        "before ![diagram](data:image/png;base64,AAAABBBBCCCC) after";
      expect(stripInlineImageBase64(input)).toBe("before ![diagram] after");
    });

    it("handles base64 payloads that contain a ) character", () => {
      // A ")" inside the payload must not prematurely end the URL.
      const input = "![x](data:image/png;base64,AA)BB==)tail";
      // depth tracking consumes up to the matching close paren of the URL.
      expect(stripInlineImageBase64(input)).toBe("![x]BB==)tail");
    });

    it("leaves non-data-URL image links untouched", () => {
      const input = "![alt](https://example.com/i.png)";
      expect(stripInlineImageBase64(input)).toBe(input);
    });

    it("leaves plain text and non-image brackets untouched", () => {
      const input = "see [note] and ![notimg without paren";
      expect(stripInlineImageBase64(input)).toBe(input);
    });

    it("returns empty input unchanged", () => {
      expect(stripInlineImageBase64("")).toBe("");
    });
  });
});
