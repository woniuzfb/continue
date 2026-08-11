import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  DEFAULT_CHUNK_BYTES,
  isBinaryContent,
  isBinaryFileName,
  MAX_INLINE_TEXT_CHARS,
  packBinaryToChunks,
  pad3,
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
    it("packs binary/archive files", () => {
      expect(shouldPackAttachment("bundle.zip", "text")).toBe(true);
      expect(shouldPackAttachment("a.bin", "x\u0000y")).toBe(true);
    });

    it("packs large text files", () => {
      expect(
        shouldPackAttachment("big.log", "a".repeat(MAX_INLINE_TEXT_CHARS + 1)),
      ).toBe(true);
    });

    it("inlines small text files", () => {
      expect(shouldPackAttachment("readme.md", "hello")).toBe(false);
      expect(
        shouldPackAttachment("ok.txt", "a".repeat(MAX_INLINE_TEXT_CHARS)),
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

    it("default chunk size matches the script's 9,000,000", () => {
      expect(DEFAULT_CHUNK_BYTES).toBe(9_000_000);
    });
  });
});
