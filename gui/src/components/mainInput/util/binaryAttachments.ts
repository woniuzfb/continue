/**
 * Binary attachment packing for the "Upload File" (+) flow.
 *
 * Binary/archive files can't be inlined as UTF-8 text: the IDE's `readFile`
 * decodes bytes to text (mangling non-ASCII) and truncates large files, so
 * the model would receive garbage (or nothing). Following the
 * pack_b64_split.sh approach, binary files are instead packed as
 *
 *   tar.gz -> base64 -> split into chunks (each under a size cap)
 *
 * and the chunks + a sha256 manifest are attached through the normal
 * attachment flow. Base64 keeps the payload intact through text-ified
 * channels; chunking keeps each piece under the channel's size cap. The
 * manifest (sha256 of the tar.gz, of the full base64, and of every part)
 * makes the payload auditable after rejoin.
 *
 * All helpers are pure / browser-API based so the whole pipeline runs in the
 * webview (no IDE-side packing needed — the IDE only provides raw bytes via
 * `readBinaryBase64`).
 */

/** Chunk cap in base64 characters. Matches the script's 9,000,000 default
 * (safely below the ~10,000,000 char hard cap of some channels). */
export const DEFAULT_CHUNK_BYTES = 9_000_000;

/**
 * Inputs that are already archives/compressed are stored as-is inside the
 * payload (no tar.gz wrapper), mirroring pack_b64_split.sh which `cp`s
 * *.tar.gz / *.tgz / *.zip / *.gz inputs verbatim. Everything else gets
 * packed into a single-file tar.gz.
 */
const STORED_AS_IS_RE = /\.(zip|gz|tgz)$/i;

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

/**
 * Writes a minimal ustar tar archive containing a single file entry, padded
 * to 512-byte blocks with two zero blocks at the end (deterministic mtime).
 */
export function writeSingleFileTar(name: string, data: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const header = new Uint8Array(512);
  const nameBytes = encoder.encode(name.slice(0, 100));
  header.set(nameBytes, 0);

  const octal = (value: number, length: number) =>
    value.toString(8).padStart(length - 1, "0") + "\0";
  // mode 0644, uid/gid 0, size, mtime 0
  header.set(encoder.encode(octal(0o644, 8)), 100);
  header.set(encoder.encode(octal(0, 8)), 108);
  header.set(encoder.encode(octal(0, 8)), 116);
  header.set(encoder.encode(octal(data.length, 12)), 124);
  header.set(encoder.encode(octal(0, 12)), 136);
  header.set(encoder.encode("0"), 156); // typeflag: regular file
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);

  // checksum: sum of header bytes with the chksum field filled with spaces.
  // Field layout (POSIX): 6 octal digits + NUL + space.
  for (let i = 148; i < 156; i++) {
    header[i] = 0x20;
  }
  let sum = 0;
  for (const b of header) {
    sum += b;
  }
  const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
  header.set(encoder.encode(checksum), 148);

  const paddedDataLen = Math.ceil(data.length / 512) * 512;
  const out = new Uint8Array(512 + paddedDataLen + 1024);
  out.set(header, 0);
  out.set(data, 512);
  return out;
}

/** gzip via the browser's CompressionStream (works in Node/webviews). */
export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    // Old webview: fail fast so the caller can fall back to the legacy
    // text attach instead of doing pointless tar work.
    throw new Error("CompressionStream is not available");
  }
  const stream = new Response(data as unknown as BodyInit).body!.pipeThrough(
    new CompressionStream("gzip"),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
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
  /** Manifest text (mirrors pack_b64_split.sh format). */
  manifest: string;
  /** Number of bytes in the packed payload (as-is file or tar.gz). */
  packedBytes: number;
}

/**
 * Packs a binary file into base64 chunks plus a sha256 manifest, mirroring
 * pack_b64_split.sh: inputs that are already archives (.zip/.gz/.tgz/.tar.gz)
 * are stored as-is; everything else is packed into a single-file tar.gz.
 * `rawBase64` must come from `ide.readBinaryBase64` (raw bytes).
 */
export async function packBinaryToChunks(
  file: { name: string; path: string; rawBase64: string },
  chunkBytes: number = DEFAULT_CHUNK_BYTES,
): Promise<PackedBinaryResult> {
  const rawBytes = base64ToBytes(file.rawBase64);
  const storeAsIs = STORED_AS_IS_RE.test(file.name);
  const payload = storeAsIs
    ? rawBytes
    : await gzipBytes(writeSingleFileTar(file.name, rawBytes));
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
    `payload_format : ${
      storeAsIs ? "original bytes (stored as-is)" : "tar.gz (single file)"
    }`,
    `tar_gz_bytes : ${payload.length}`,
    `tar_gz_sha256 : ${payloadSha}`,
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
