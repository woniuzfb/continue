import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  DEFAULT_CHUNK_BYTES,
  isBinaryContent,
  isBinaryFileName,
  MAX_INLINE_FILE_BYTES,
  packBinaryToChunks,
  pad3,
  sha256Hex,
  shouldPackAttachment,
} from "./binaryAttachments";

describe("binaryAttachments", () => {
  describe("binary detection", () => {
    it("detects known binary/archive extensions", () => {
      expect(isBinaryFileName("bundle.zip")).toBe(true);
      expect(isBinaryFileName("archive.tar.gz")).toBe(true);
      expect(isBinaryFileName("setup.exe")).toBe(true);
      expect(isBinaryFileName("doc.docx")).toBe(true);
      expect(isBinaryFileName("index.tsx")).toBe(false);
      expect(isBinaryFileName("README.md")).toBe(false);
    });

    it("sniffs NUL bytes in content", () => {
      expect(isBinaryContent("hello\u0000world")).toBe(true);
      expect(isBinaryContent("plain text")).toBe(false);
    });
  });

  describe("shouldPackAttachment", () => {
    it("packs binary/archive files regardless of size", () => {
      expect(shouldPackAttachment("bundle.zip", "text")).toBe(true);
      expect(shouldPackAttachment("a.bin", "x\u0000y", 10)).toBe(true);
    });

    it("packs ANY file whose real byte size exceeds the cap", () => {
      expect(
        shouldPackAttachment(
          "readme.md",
          "short content",
          MAX_INLINE_FILE_BYTES + 1,
        ),
      ).toBe(true);
      // Huge file whose readFile text came back empty (truncation) still
      // packs when the real size is known.
      expect(shouldPackAttachment("big.log", "", 500_000_000)).toBe(true);
    });

    it("defaults to splitting above 1 MB", () => {
      expect(MAX_INLINE_FILE_BYTES).toBe(1_000_000);
      expect(shouldPackAttachment("a.txt", "x", 1_000_000)).toBe(false);
      expect(shouldPackAttachment("a.txt", "x", 1_000_001)).toBe(true);
    });

    it("respects an explicit inline limit", () => {
      expect(shouldPackAttachment("a.txt", "x", 500_000, 100_000)).toBe(true);
      expect(shouldPackAttachment("a.txt", "x", 50_000, 100_000)).toBe(false);
    });

    it("inlines small files", () => {
      expect(shouldPackAttachment("readme.md", "hello")).toBe(false);
      expect(shouldPackAttachment("ok.txt", "a".repeat(1000), 1000)).toBe(
        false,
      );
      expect(
        shouldPackAttachment(
          "ok.txt",
          "a".repeat(MAX_INLINE_FILE_BYTES),
          MAX_INLINE_FILE_BYTES,
        ),
      ).toBe(false);
    });
  });

  describe("base64 helpers", () => {
    it("round-trips arbitrary bytes", () => {
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });

    it("round-trips large payloads (multi-chunk)", () => {
      const bytes = new Uint8Array(200_000);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = i % 251;
      }
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });
  });

  describe("packBinaryToChunks", () => {
    it("round-trips: chunks -> rejoin -> base64 decode -> EXACT original bytes (no format change)", async () => {
      // Incompressible deterministic data (LCG) so the payload actually
      // splits into multiple chunks.
      let seed = 42;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed;
      };
      const original = new Uint8Array(500_000);
      for (let i = 0; i < original.length; i++) {
        original[i] = rand() >>> 24; // high byte: good entropy
      }
      const rawBase64 = bytesToBase64(original);

      const result = await packBinaryToChunks(
        { name: "payload.bin", path: "/tmp/payload.bin", rawBase64 },
        // small chunks to force splitting
        100_000,
      );

      expect(result.chunks.length).toBeGreaterThan(1);
      for (const chunk of result.chunks) {
        expect(chunk.length).toBeLessThanOrEqual(100_000);
      }
      // Rejoining the chunks and decoding must yield the ORIGINAL bytes:
      // no tar, no gzip, no format transformation whatsoever.
      const recovered = base64ToBytes(result.chunks.join(""));
      expect(recovered).toEqual(original);
      expect(result.packedBytes).toBe(original.length);
    });

    it("keeps text files as the original bytes too (large .txt case)", async () => {
      const text = "line1\nline2\n".repeat(50_000); // 350k chars > inline cap
      const original = new TextEncoder().encode(text);
      const result = await packBinaryToChunks(
        {
          name: "big.log",
          path: "/x/big.log",
          rawBase64: bytesToBase64(original),
        },
        100_000,
      );
      const recovered = new TextDecoder().decode(
        base64ToBytes(result.chunks.join("")),
      );
      expect(recovered).toBe(text);
      expect(result.manifest).toContain(
        "payload_format : original bytes (stored as-is)",
      );
    });

    it("builds a manifest with accurate payload fields", async () => {
      const original = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
      const result = await packBinaryToChunks(
        {
          name: "bundle.zip",
          path: "/x/bundle.zip",
          rawBase64: bytesToBase64(original),
        },
        1000,
      );
      const lines = result.manifest.split("\n");
      expect(lines[0]).toBe("# base64 split manifest");
      expect(lines).toContain("source_path : /x/bundle.zip");
      expect(lines).toContain("payload_format : original bytes (stored as-is)");
      expect(lines).toContain(`payload_bytes : ${original.length}`);
      expect(lines).toContain(`chunk_bytes : 1000`);
      expect(lines).toContain(`part_count : ${result.chunks.length}`);
      // payload_sha256 is the sha of the ORIGINAL file bytes.
      const shaLine = lines.find((l) => l.startsWith("payload_sha256"));
      expect(shaLine).toMatch(/^payload_sha256 : [0-9a-f]{64}$/);
      // each part listed with hash + byte count
      for (let i = 0; i < result.chunks.length; i++) {
        const line = lines.find((l) =>
          l.startsWith(`bundle.zip.b64.${pad3(i)}`),
        );
        expect(line).toBeDefined();
        expect(line).toMatch(
          /^bundle\.zip\.b64\.\d{3}  ([0-9a-f]{64}|unavailable)  \d+ bytes$/,
        );
      }
      // hash is hex (or "unavailable")
      const b64ShaLine = lines.find((l) => l.startsWith("b64_total_sha256"));
      expect(b64ShaLine).toMatch(
        /^b64_total_sha256 : (([0-9a-f]{64})|unavailable)$/,
      );
    });

    it("hashes every part in the base64 space, so parts chain to b64_total", async () => {
      // Regression: the part lines used to hash each part's DECODED bytes, which
      // lives in payload space — the manifest has no total there to check them
      // against. `b64_total_sha256` is the base64 text, so the parts must be too.
      const original = new Uint8Array(1024);
      for (let i = 0; i < original.length; i++) {
        original[i] = (i * 7) % 256;
      }
      const result = await packBinaryToChunks(
        {
          name: "bundle.tar.gz",
          path: "/x/bundle.tar.gz",
          rawBase64: bytesToBase64(original),
        },
        256, // 1368 base64 chars => several parts
      );
      expect(result.chunks.length).toBeGreaterThan(1);

      const utf8 = (s: string) => new TextEncoder().encode(s);
      const joined = result.chunks.join("");
      const lines = result.manifest.split("\n");

      // payload_sha256 is the DECODED payload …
      expect(lines).toContain(`payload_sha256 : ${await sha256Hex(original)}`);
      // … while b64_total_sha256 and every part line hash the base64 TEXT.
      expect(lines).toContain(
        `b64_total_sha256 : ${await sha256Hex(utf8(joined))}`,
      );

      let partChars = 0;
      for (let i = 0; i < result.chunks.length; i++) {
        const chunk = result.chunks[i];
        partChars += chunk.length;
        expect(lines).toContain(
          `bundle.tar.gz.b64.${pad3(i)}  ${await sha256Hex(
            utf8(chunk),
          )}  ${chunk.length} bytes`,
        );
      }
      // The parts partition the base64 text, and rejoin to the original bytes.
      expect(partChars).toBe(joined.length);
      expect(lines).toContain(`b64_total_bytes : ${joined.length}`);
      expect(base64ToBytes(joined)).toEqual(original);
    });

    it("default chunk size matches the script's 9,000,000", () => {
      expect(DEFAULT_CHUNK_BYTES).toBe(9_000_000);
    });
  });
});
