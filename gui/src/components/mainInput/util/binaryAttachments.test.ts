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
  writeSingleFileTar,
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

  describe("writeSingleFileTar", () => {
    it("produces a valid ustar header with correct checksum", () => {
      const data = new TextEncoder().encode("hello tar");
      const tar = writeSingleFileTar("payload.bin", data);
      expect(tar.length).toBe(512 + 512 + 1024); // header + data block + 2 zero blocks
      const header = tar.slice(0, 512);
      // ustar magic + version
      expect(new TextDecoder().decode(header.slice(257, 263))).toBe("ustar\0");
      expect(new TextDecoder().decode(header.slice(263, 265))).toBe("00");
      // typeflag = regular file
      expect(String.fromCharCode(header[156])).toBe("0");
      // checksum field: 6 octal digits + NUL + space
      const chkField = new TextDecoder().decode(header.slice(148, 156));
      expect(chkField.endsWith("\0 ")).toBe(true);
      const storedSum = parseInt(chkField.trim(), 8);
      // recompute: sum of header with checksum field as spaces
      const copy = header.slice();
      for (let i = 148; i < 156; i++) copy[i] = 0x20;
      const computedSum = copy.reduce((a, b) => a + b, 0);
      expect(storedSum).toBe(computedSum);
    });
  });

  describe("packBinaryToChunks", () => {
    it("round-trips: chunks -> rejoin -> gunzip -> untar -> original bytes", async () => {
      // Incompressible deterministic data (LCG), so gzip doesn't collapse it
      // and the payload actually splits into multiple chunks.
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
      // rejoin base64
      const fullB64 = result.chunks.join("");
      const gz = base64ToBytes(fullB64);
      // gunzip
      const stream = new Response(gz as unknown as BodyInit).body!.pipeThrough(
        new DecompressionStream("gzip"),
      );
      const tar = new Uint8Array(await new Response(stream).arrayBuffer());
      // strip 512-byte header + padding + 1024-byte trailer
      const dataStart = 512;
      const dataEnd = tar.length - 1024;
      const padded = tar.slice(dataStart, dataEnd);
      expect(padded.length).toBe(Math.ceil(original.length / 512) * 512);
      const recovered = padded.slice(0, original.length);
      expect(recovered).toEqual(original);
    });

    it("stores already-archived inputs (.zip) as-is, not inside a tar.gz", async () => {
      // A zip that starts with the PK magic bytes; gzip has no effect on it.
      const original = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
      const result = await packBinaryToChunks(
        {
          name: "bundle.zip",
          path: "/x/bundle.zip",
          rawBase64: bytesToBase64(original),
        },
        1000,
      );
      // Rejoined + decoded payload must be the zip bytes themselves
      // (no tar header, no gzip wrapper).
      const payload = base64ToBytes(result.chunks.join(""));
      expect(payload).toEqual(original);
      expect(result.manifest).toContain(
        "payload_format : original bytes (stored as-is)",
      );
      // The stored sha is the sha of the zip itself.
      const shaLine = result.manifest
        .split("\n")
        .find((l) => l.startsWith("tar_gz_sha256"));
      expect(shaLine).toMatch(/^tar_gz_sha256 : [0-9a-f]{64}$/);
    });

    it("builds a manifest mirroring the script format", async () => {
      const raw = new TextEncoder().encode("some binary-ish content");
      const result = await packBinaryToChunks(
        { name: "foo.bin", path: "/x/foo.bin", rawBase64: bytesToBase64(raw) },
        1000,
      );
      const lines = result.manifest.split("\n");
      expect(lines[0]).toBe("# base64 split manifest");
      expect(lines).toContain("source_path : /x/foo.bin");
      expect(lines).toContain("payload_format : tar.gz (single file)");
      expect(lines).toContain(`chunk_bytes : 1000`);
      expect(lines).toContain(`part_count : ${result.chunks.length}`);
      // each part listed with hash + byte count
      for (let i = 0; i < result.chunks.length; i++) {
        const line = lines.find((l) => l.startsWith(`foo.bin.b64.${pad3(i)}`));
        expect(line).toBeDefined();
        expect(line).toMatch(
          /^foo\.bin\.b64\.\d{3}  ([0-9a-f]{64}|unavailable)  \d+ bytes$/,
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
