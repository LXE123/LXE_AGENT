import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { detectReadImageMime, ModelImageProcessor, type ModelImageResult } from "../../src/providers/model-image";

const MAX_BASE64_BYTES = 4.5 * 1024 * 1024;
const BINARY_BOUNDARY = MAX_BASE64_BYTES / 4 * 3;
const fixtureJpeg = (): Uint8Array => new Uint8Array(readFileSync(
  resolve(import.meta.dir, "../fixtures/color-pattern.jpg"),
));

const expectValidReadImage = async (result: ModelImageResult): Promise<void> => {
  expect(Buffer.from(result.bytes).toString("base64").length).toBeLessThan(MAX_BASE64_BYTES);
  expect(result.processed.sizeBytes).toBe(result.bytes.byteLength);
  const decoded = await new Bun.Image(result.bytes).png().bytes();
  const metadata = await new Bun.Image(decoded).metadata();
  expect([metadata.width, metadata.height]).toEqual([result.processed.width, result.processed.height]);
  expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(2_000);
  expect(detectReadImageMime(result.bytes)).toBe(result.mediaType);
};

// Stub only the codec boundary for size/quality combinations that real codecs
// cannot reliably reproduce across platforms. Other tests decode real outputs.
interface TestEncoder {
  encode(bytes: Uint8Array, width: number, height: number, format: "png" | "jpeg", quality?: number): Promise<{
    bytes: Uint8Array; mediaType: "image/png" | "image/jpeg"; width: number; height: number;
  }>;
}

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

const fixturePng = (width: number, height: number, { alpha = true, noise = false } = {}): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  const stride = 1 + width * (alpha ? 4 : 3);
  const scanlines = new Uint8Array(height * stride);
  let seed = 123456789;
  for (let index = 0; index < scanlines.length; index += 1) {
    if (index % stride === 0) continue;
    if (noise) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      scanlines[index] = seed & 255;
    } else {
      // Alternate opaque and transparent pixels to exercise alpha preservation.
      scanlines[index] = index % 8 < 4 ? 255 : 0;
    }
  }
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
    const bytes = fixturePng(2, 1);
    expect(detectReadImageMime(bytes)).toBe("image/png");
    const result = await new ModelImageProcessor().process(bytes, "read");
    expect(result.bytes).toEqual(bytes);
    expect(result.mediaType).toBe("image/png");
    expect(result.original).toMatchObject({ width: 2, height: 1, hasAlpha: true });
    await expectValidReadImage(result);
  });

  test("preserves compliant JPEG bytes without converting to PNG", async () => {
    const bytes = fixtureJpeg();
    const result = await new ModelImageProcessor().process(bytes, "read");
    expect(result.bytes).toBe(bytes);
    expect(result.mediaType).toBe("image/jpeg");
    await expectValidReadImage(result);
  });

  for (const delta of [-3, -2, -1, 0, 1]) {
    test(`uses the Base64 budget including padding at binary boundary ${delta}`, async () => {
      const png = fixturePng(2, 1);
      const size = BINARY_BOUNDARY + delta;
      // A valid ancillary chunk makes a tiny decodable PNG exactly the desired
      // byte length without requiring an expensive, unpredictable noisy image.
      const padding = new Uint8Array(size - png.byteLength - 12).fill(97);
      padding.set(new TextEncoder().encode("padding\0"));
      const bytes = new Uint8Array(Buffer.concat([
        png.subarray(0, -12), pngChunk("tEXt", padding), png.subarray(-12),
      ]));
      expect(bytes.byteLength).toBe(size);
      expect(bytes.byteLength).toBeLessThan(MAX_BASE64_BYTES);
      const encodedSize = Buffer.from(bytes).toString("base64").length;
      const result = await new ModelImageProcessor().process(bytes, "read");
      if (encodedSize < MAX_BASE64_BYTES) {
        expect(result.bytes).toBe(bytes);
      } else {
        expect(result.bytes.byteLength).toBeLessThan(bytes.byteLength);
      }
      expect(result.original.sizeBytes).toBe(size);
      await expectValidReadImage(result);
    });
  }

  test("resizes transparent images without converting them to JPEG", async () => {
    const result = await new ModelImageProcessor().process(fixturePng(2_100, 2), "read");
    expect(result.mediaType).toBe("image/png");
    expect(result.processed.width).toBeLessThanOrEqual(2_000);
    expect(result.processed.height).toBeLessThanOrEqual(2_000);
    expect(result.processed.hasAlpha).toBe(true);
    expect(result.bytes[25]).toBe(6); // PNG RGBA color type.
    await expectValidReadImage(result);
  });

  test("prefers a fitting PNG even when a fitting JPEG would be smaller", async () => {
    const fixture = fixtureJpeg();
    const oversized = await new Bun.Image(fixture).resize(2_600, 2_600, { fit: "inside" }).jpeg({ quality: 95 }).bytes();
    const result = await new ModelImageProcessor().process(oversized, "read");
    expect(result.mediaType).toBe("image/png");
    const jpeg = await new Bun.Image(oversized)
      .resize(result.processed.width, result.processed.height, { fit: "inside" }).jpeg({ quality: 85 }).bytes();
    expect(jpeg.byteLength).toBeLessThan(result.bytes.byteLength);
    expect(Buffer.from(jpeg).toString("base64").length).toBeLessThan(MAX_BASE64_BYTES);
    await expectValidReadImage(result);
  });

  test("uses JPEG at the same resolution when a real PNG exceeds the budget", async () => {
    const bytes = fixturePng(1_200, 1_200, { alpha: false, noise: true });
    expect(Buffer.from(bytes).toString("base64").length).toBeGreaterThan(MAX_BASE64_BYTES);
    const result = await new ModelImageProcessor().process(bytes, "read");
    expect(result.mediaType).toBe("image/jpeg");
    expect([result.processed.width, result.processed.height]).toEqual([1_200, 1_200]);
    await expectValidReadImage(result);
  });

  test("tries descending JPEG quality and stops at the first fitting candidate", async () => {
    const processor = new ModelImageProcessor();
    const oversized = new Uint8Array(BINARY_BOUNDARY - 1); // Padding brings it exactly to the limit.
    const fitting = new Uint8Array([1, 2]);
    const encode = spyOn(processor as unknown as TestEncoder, "encode").mockImplementation(
      async (_bytes, width, height, format, quality) => ({
        bytes: format === "jpeg" && quality === 80 ? fitting : oversized,
        mediaType: format === "png" ? "image/png" : "image/jpeg", width, height,
      }),
    );
    try {
      const result = await processor.process(fixturePng(2_100, 20, { alpha: false }), "read");
      expect(result.bytes).toBe(fitting);
      expect(encode.mock.calls.map((call) => call.slice(1))).toEqual([
        [2_000, 19, "png"], [2_000, 19, "jpeg", 85], [2_000, 19, "jpeg", 80],
      ]);
    } finally { encode.mockRestore(); }
  });

  test("exhausts same-size JPEG candidates before shrinking and retries PNG first", async () => {
    const processor = new ModelImageProcessor();
    const oversized = new Uint8Array(BINARY_BOUNDARY);
    const fitting = new Uint8Array([1, 2]);
    const encode = spyOn(processor as unknown as TestEncoder, "encode").mockImplementation(
      async (_bytes, width, height, format) => ({
        bytes: width === 1_500 ? fitting : oversized,
        mediaType: format === "png" ? "image/png" : "image/jpeg", width, height,
      }),
    );
    try {
      const result = await processor.process(fixturePng(2_100, 20, { alpha: false }), "read");
      expect(result.mediaType).toBe("image/png");
      expect(encode.mock.calls.map((call) => call.slice(1))).toEqual([
        [2_000, 19, "png"], ...[85, 80, 70, 55, 40].map((quality) => [2_000, 19, "jpeg" as const, quality]),
        [1_500, 14, "png"],
      ]);
    } finally { encode.mockRestore(); }
  });

  test("keeps transparent candidates in PNG and reports the smallest encoded size on exhaustion", async () => {
    const processor = new ModelImageProcessor();
    const oversized = new Uint8Array(BINARY_BOUNDARY + 1);
    const boundary = new Uint8Array(BINARY_BOUNDARY - 1);
    const encode = spyOn(processor as unknown as TestEncoder, "encode").mockImplementation(
      async (_bytes, width, height) => ({
        bytes: width === 1_000 ? boundary : oversized, mediaType: "image/png", width, height,
      }),
    );
    try {
      await expect(processor.process(fixturePng(2_100, 20), "read")).rejects.toMatchObject({
        code: "ERR_IMAGE_OUTPUT_TOO_LARGE",
        message: `processed image must be below ${MAX_BASE64_BYTES} Base64 bytes (smallest=${MAX_BASE64_BYTES} Base64 bytes)`,
      });
      expect(encode.mock.calls.map((call) => call.slice(1))).toEqual([
        [2_000, 19, "png"], [1_500, 14, "png"], [1_000, 10, "png"], [700, 7, "png"], [500, 5, "png"],
      ]);
    } finally { encode.mockRestore(); }
  });

  test("preserves the Feishu JPEG quality and resize profile", async () => {
    const bytes = fixtureJpeg();
    const result = await new ModelImageProcessor().process(bytes, "feishu");
    const scale = Math.min(1_024 / result.original.width, 1_024 / result.original.height, 1);
    const width = Math.max(1, Math.round(result.original.width * scale));
    const height = Math.max(1, Math.round(result.original.height * scale));
    const expected = await new Bun.Image(bytes, { autoOrient: true, maxPixels: 40_000_000 })
      .resize(width, height, { fit: "inside", withoutEnlargement: true, filter: "lanczos3" })
      .jpeg({ quality: 60, progressive: false }).bytes();
    expect(Buffer.from(result.bytes).equals(Buffer.from(expected))).toBe(true);
    expect(result.mediaType).toBe("image/jpeg");
    expect(Math.max(result.processed.width, result.processed.height)).toBeLessThanOrEqual(1_024);
  });
});
