import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { detectReadImageMime, ModelImageProcessor } from "../src/model-image";

const crcTable = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const pngChunk = (name: string, data: Uint8Array): Uint8Array => {
  const type = new TextEncoder().encode(name);
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength);
  output.set(type, 4);
  output.set(data, 8);
  const checksum = new Uint8Array(type.byteLength + data.byteLength);
  checksum.set(type);
  checksum.set(data, type.byteLength);
  view.setUint32(8 + data.byteLength, crc32(checksum));
  return output;
};

const transparentPng = (width: number, height: number): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const scanlines = new Uint8Array(height * (1 + width * 4));
  const chunks = [pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", new Uint8Array())];
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const output = new Uint8Array(signature.byteLength + chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  output.set(signature);
  let offset = signature.byteLength;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

describe("ModelImageProcessor", () => {
  test("sniffs image content and preserves compliant original bytes", async () => {
    const bytes = transparentPng(2, 1);
    expect(detectReadImageMime(bytes)).toBe("image/png");
    const result = await new ModelImageProcessor().process(bytes, "read");
    expect(result.bytes).toEqual(bytes);
    expect(result.mediaType).toBe("image/png");
    expect(result.original).toMatchObject({ width: 2, height: 1, hasAlpha: true });
  });

  test("resizes transparent images without converting them to JPEG", async () => {
    const result = await new ModelImageProcessor().process(transparentPng(2_100, 2), "read");
    expect(result.mediaType).toBe("image/png");
    expect(result.processed.width).toBeLessThanOrEqual(2_000);
    expect(result.processed.height).toBeLessThanOrEqual(2_000);
    expect(result.processed.sizeBytes).toBeLessThanOrEqual(Math.trunc(4.5 * 1024 * 1024));
  });

  test("bounds oversized screenshots using the main-compatible read profile", async () => {
    const fixture = new Uint8Array(readFileSync(resolve(
      import.meta.dir,
      "../../../skills/replenishment-amazon-fba-inventory-snapshot/assets/amazon_fba_inventory_download_step_1_menu.jpg",
    )));
    const oversized = await new Bun.Image(fixture).resize(2_600, 2_600, { fit: "inside" }).jpeg({ quality: 95 }).bytes();
    const result = await new ModelImageProcessor().process(oversized, "read");
    expect(Math.max(result.processed.width, result.processed.height)).toBeLessThanOrEqual(2_000);
    expect(result.processed.sizeBytes).toBeLessThanOrEqual(Math.trunc(4.5 * 1024 * 1024));
    expect(["image/jpeg", "image/png"]).toContain(result.mediaType);
  });
});
