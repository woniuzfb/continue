export interface ParsedLocalFileLink {
  fileUri: string;
  /** 0-indexed start line for IDE `showLines` */
  startLine?: number;
  /** 0-indexed end line for IDE `showLines` */
  endLine?: number;
}

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[/\\]/;
const HASH_LINE_RE = /#L(\d+)(?:-L?(\d+))?$/i;
const COLON_LINE_RE = /:(\d+)(?:-(\d+))?(?::\d+)?$/;
const RELATIVE_FILE_HINT_RE = /(?:^|\/)[^/]+\.[a-zA-Z0-9]{1,12}$/;

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePosixPathToFileUri(posixPath: string): string {
  const normalized = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  const encoded = normalized
    .split("/")
    .map((segment) => encodeURIComponent(safeDecodeURIComponent(segment)))
    .join("/");
  return `file://${encoded}`;
}

function stripLineSuffix(raw: string): {
  pathPart: string;
  startLine?: number;
  endLine?: number;
} {
  const hashMatch = HASH_LINE_RE.exec(raw);
  if (hashMatch) {
    const start = Number.parseInt(hashMatch[1], 10);
    const end = hashMatch[2] ? Number.parseInt(hashMatch[2], 10) : start;
    const startLine = Math.max(0, start - 1);
    const endLine = Math.max(startLine, end - 1);
    return {
      pathPart: raw.slice(0, hashMatch.index),
      startLine,
      endLine,
    };
  }

  const colonMatch = COLON_LINE_RE.exec(raw);
  if (colonMatch) {
    // Avoid mistaking Windows drive letter "C:" at index 1 as a line suffix
    if (colonMatch.index > 1) {
      const start = Number.parseInt(colonMatch[1], 10);
      const end = colonMatch[2] ? Number.parseInt(colonMatch[2], 10) : start;
      const startLine = Math.max(0, start - 1);
      const endLine = Math.max(startLine, end - 1);
      return {
        pathPart: raw.slice(0, colonMatch.index),
        startLine,
        endLine,
      };
    }
  }

  return { pathPart: raw };
}

/**
 * Parses a Markdown link `href` pointing to a local file (absolute POSIX/Windows path,
 * `file://` URI, or workspace-relative path) with optional `#L10`, `#L10-L20`, `:10`,
 * `:10-20`, or `:10:5` line suffixes. Returns `null` for web/external URLs or anchors.
 */
export function parseLocalFileLink(
  href: string,
  workspacePaths?: string[],
): ParsedLocalFileLink | null {
  const trimmed = (href ?? "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  const isFileUri = lower.startsWith("file://");
  if (!isFileUri && URI_SCHEME_RE.test(trimmed)) {
    return null;
  }

  const { pathPart, startLine, endLine } = stripLineSuffix(trimmed);
  if (!pathPart) {
    return null;
  }

  if (isFileUri) {
    const cleanUri = pathPart.split(/[?#]/)[0];
    if (!cleanUri || cleanUri === "file://") {
      return null;
    }
    return { fileUri: cleanUri, startLine, endLine };
  }

  if (pathPart.startsWith("/")) {
    const cleanPath = pathPart.split(/[?#]/)[0];
    if (!cleanPath || cleanPath === "/") {
      return null;
    }
    return {
      fileUri: encodePosixPathToFileUri(cleanPath),
      startLine,
      endLine,
    };
  }

  if (WINDOWS_DRIVE_RE.test(pathPart)) {
    const cleanPath = pathPart.split(/[?#]/)[0].replace(/\\/g, "/");
    return {
      fileUri: encodePosixPathToFileUri(`/${cleanPath}`),
      startLine,
      endLine,
    };
  }

  // Relative workspace path
  const baseWorkspace = workspacePaths?.[0]?.trim();
  if (!baseWorkspace) {
    return null;
  }

  const cleanRel = pathPart.split(/[?#]/)[0];
  const looksLikeFilePath =
    cleanRel.startsWith("./") ||
    cleanRel.startsWith("../") ||
    cleanRel.includes("/") ||
    RELATIVE_FILE_HINT_RE.test(cleanRel) ||
    startLine !== undefined;
  if (!cleanRel || !looksLikeFilePath) {
    return null;
  }

  const baseUri = baseWorkspace.toLowerCase().startsWith("file://")
    ? baseWorkspace
    : encodePosixPathToFileUri(baseWorkspace);
  const normalizedBase = baseUri.endsWith("/") ? baseUri : `${baseUri}/`;
  try {
    const resolved = new URL(cleanRel, normalizedBase).toString();
    if (!resolved.toLowerCase().startsWith("file://")) {
      return null;
    }
    return {
      fileUri: resolved,
      startLine,
      endLine,
    };
  } catch {
    return null;
  }
}
