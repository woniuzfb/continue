import { describe, expect, it } from "vitest";
import { parseLocalFileLink } from "./parseLocalFileLink";

describe("parseLocalFileLink", () => {
  it("ignores external schemes, anchors, and protocol-relative links", () => {
    expect(parseLocalFileLink("custom-scheme:foo/bar")).toBeNull();
    expect(parseLocalFileLink("#section-1")).toBeNull();
    expect(parseLocalFileLink("//host/a.js")).toBeNull();
    expect(parseLocalFileLink("")).toBeNull();
  });

  it("parses POSIX absolute paths with and without line numbers", () => {
    const scheme = "file" + "://";
    expect(parseLocalFileLink("/w/project/app.py")).toEqual({
      fileUri: `${scheme}/w/project/app.py`,
      startLine: undefined,
      endLine: undefined,
    });
    expect(parseLocalFileLink("/w/project/app.py#L16")).toEqual({
      fileUri: `${scheme}/w/project/app.py`,
      startLine: 15,
      endLine: 15,
    });
    expect(parseLocalFileLink("/w/project/app.py#L16-L24")).toEqual({
      fileUri: `${scheme}/w/project/app.py`,
      startLine: 15,
      endLine: 23,
    });
    expect(parseLocalFileLink("/w/project/app.py:42")).toEqual({
      fileUri: `${scheme}/w/project/app.py`,
      startLine: 41,
      endLine: 41,
    });
    expect(parseLocalFileLink("/w/project/app.py:10-20")).toEqual({
      fileUri: `${scheme}/w/project/app.py`,
      startLine: 9,
      endLine: 19,
    });
    expect(parseLocalFileLink("/w/project/app.py:10:5")).toEqual({
      fileUri: `${scheme}/w/project/app.py`,
      startLine: 9,
      endLine: 9,
    });
  });

  it("encodes spaces in POSIX absolute paths cleanly", () => {
    const scheme = "file" + "://";
    expect(parseLocalFileLink("/w/my folder/file name.ts#L5")).toEqual({
      fileUri: `${scheme}/w/my%20folder/file%20name.ts`,
      startLine: 4,
      endLine: 4,
    });
  });

  it("parses file URIs and workspace-relative paths", () => {
    const scheme = "file" + "://";
    expect(parseLocalFileLink(`${scheme}/w/project/app.py#L10-L12`)).toEqual({
      fileUri: `${scheme}/w/project/app.py`,
      startLine: 9,
      endLine: 11,
    });
    expect(
      parseLocalFileLink("core/util/history.ts#L67-L70", [`${scheme}/w/repo`]),
    ).toEqual({
      fileUri: `${scheme}/w/repo/core/util/history.ts`,
      startLine: 66,
      endLine: 69,
    });
    expect(parseLocalFileLink("core/util/history.ts#L67")).toBeNull();
  });
});
