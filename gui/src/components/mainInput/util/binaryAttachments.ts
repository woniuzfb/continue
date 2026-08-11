/**
 * Attachment packing for the "Upload File" (+) flow.
 *
 * Binary/archive files can't be inlined as UTF-8 text: the IDE's `readFile`
 * decodes bytes to text (mangling non-ASCII) and truncates large files, so
 * the model would receive garbage (or nothing). Large text files would blow
 * the context window and are silently truncated by the IDE.
 *
 * Such files are instead base64-encoded and split into chunks (each under a
 * size cap), plus a sha256 manifest:
 *
 *   original bytes -> base64 -> split into chunks
 *
 * The ORIGINAL file format is never changed: no tar, no re-compression. The
 * payload is simply the raw bytes of the file, base64-transported. The
 * receiver rejoins the chunks, base64-decodes, and gets the exact original
 * file (verified against payload_sha256). The manifest also lists the sha256
 * of the full base64 and of every part.
 *
 * All helpers are pure / browser-API based so the whole pipeline runs in the
 * webview (no IDE-side packing needed — the IDE only provides raw bytes via
 * `readBinaryBase64`).
 */

/** Chunk cap in base64 characters. Matches the script's 9,000,000 default
 * (safely below the ~10,000,000 char hard cap of some channels). */
export const DEFAULT_CHUNK_BYTES = 9_000_000;

/**
 * Default inline cap: files larger than this (real byte size) are packed
 * (base64 -> chunks) instead of being inlined, so they are not truncated
 * (the IDE's readFile caps at 10MB and returns "" past 100MB) and don't
 * blow the context window. Applies to ANY file type. The UI setting
 * `ui.attachmentSplitThresholdMB` overrides this (default 1 MB).
 */
export const MAX_INLINE_FILE_BYTES = 1_000_000;

/** Well-known extensions that cannot be meaningfully inlined as UTF-8 text. */
const BINARY_EXTENSIONS = new Set([
  // archives
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "rar",
  "7z",
  "jar",
  "war",
  // executables / binaries
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "class",
  "pyc",
  "o",
  "a",
  "lib",
  "wasm",
  // images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tiff",
  "svgz",
  // fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  // media
  "mp3",
  "mp4",
  "avi",
  "mov",
  "mkv",
  "wav",
  "flac",
  "ogg",
  "webm",
  // office documents (zip-based or binary)
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  // misc
  "iso",
  "img",
  "dmg",
  "pkg",
  "apk",
  "ipa",
  "deb",
  "rpm",
  "msi",
  "pak",
  "psd",
  "sketch",
  "db",
  "sqlite",
  "sqlite3",
  "lock",
]);

export function isBinaryFileName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Heuristic binary sniff: most binary formats contain NUL bytes, which
 * survive the UTF-8 text decode as "\u0000". Text files almost never do.
 */
export function isBinaryContent(content: string): boolean {
  return content.slice(0, 8_000).includes("\u0000");
}

/**
 * True when an attached file should go through the pack pipeline instead of
 * being inlined as text: binary/archive files, or ANY file whose real byte
 * size exceeds the inline limit. `fileSize` is the authoritative size from
 * the IDE stats (readFile text is truncated and unreliable for big files);
 * when unavailable it falls back to the content length.
 */
export function shouldPackAttachment(
  name: string,
  content: string,
  fileSize?: number,
  inlineLimitBytes: number = MAX_INLINE_FILE_BYTES,
): boolean {
  return (
    isBinaryFileName(name) ||
    isBinaryContent(content) ||
    (fileSize ?? content.length) > inlineLimitBytes
  );
}

/** Chunked base64 decode (handles multi-MB strings without call-stack blowup). */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Chunked base64 encode (avoids String.fromCharCode(...spread) limits). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** SHA-256 hex digest. Returns "unavailable" when WebCrypto is missing. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === "undefined" || !crypto?.subtle) {
    return "unavailable";
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export interface PackedBinaryResult {
  /** Base64 chunks, in order. */
  chunks: string[];
  /** Manifest text. */
  manifest: string;
  /** Number of bytes in the payload (the original file, before base64). */
  packedBytes: number;
}

/**
 * Splits a file's raw bytes into base64 chunks plus a sha256 manifest. The
 * payload is the ORIGINAL bytes — never re-packaged (no tar, no gzip) — so
 * rejoining the chunks and base64-decoding yields the exact original file.
 * `rawBase64` must come from `ide.readBinaryBase64` (raw bytes).
 */
export async function packBinaryToChunks(
  file: { name: string; path: string; rawBase64: string },
  chunkBytes: number = DEFAULT_CHUNK_BYTES,
): Promise<PackedBinaryResult> {
  const payload = base64ToBytes(file.rawBase64);
  const fullB64 = bytesToBase64(payload);

  const chunks: string[] = [];
  for (let i = 0; i < fullB64.length; i += chunkBytes) {
    chunks.push(fullB64.slice(i, i + chunkBytes));
  }

  const [payloadSha, b64Sha] = await Promise.all([
    sha256Hex(payload),
    sha256Hex(new TextEncoder().encode(fullB64)),
  ]);
  const partHashes = await Promise.all(
    chunks.map((c) => sha256Hex(base64ToBytes(c))),
  );

  const partCount = chunks.length;
  const lines = [
    "# base64 split manifest",
    `# generated: ${new Date().toISOString()}`,
    `source_path : ${file.path}`,
    "payload_format : original bytes (stored as-is)",
    `payload_bytes : ${payload.length}`,
    `payload_sha256 : ${payloadSha}`,
    `b64_total_bytes : ${fullB64.length}`,
    `b64_total_sha256 : ${b64Sha}`,
    `chunk_bytes : ${chunkBytes}`,
    `part_count : ${partCount}`,
    "# --- parts (concatenate in this exact order) ---",
  ];
  for (let i = 0; i < partCount; i++) {
    lines.push(
      `${file.name}.b64.${pad3(i)}  ${partHashes[i]}  ${chunks[i].length} bytes`,
    );
  }

  return { chunks, manifest: lines.join("\n"), packedBytes: payload.length };
}
