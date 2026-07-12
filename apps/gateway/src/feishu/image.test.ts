import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { InboundImageError, InboundImageProcessor } from "./image";

const roots: string[] = [];
const jpegFixture = new Uint8Array(readFileSync(resolve(
  import.meta.dir,
  "../../../../skills/replenishment-amazon-fba-inventory-snapshot/assets/amazon_fba_inventory_download_step_1_menu.jpg",
)));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const onePixelGif = new Uint8Array(Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
));

const onePixelBmp = (): Uint8Array => {
  const bytes = new Uint8Array(58);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, bytes.byteLength, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 1, true);
  view.setInt32(22, 1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, 4, true);
  bytes.set([0, 0, 255, 0], 54);
  return bytes;
};

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
  const checksumInput = new Uint8Array(type.byteLength + data.byteLength);
  checksumInput.set(type);
  checksumInput.set(data, type.byteLength);
  view.setUint32(8 + data.byteLength, crc32(checksumInput));
  return output;
};

const pngHeader = (width: number, height: number, withPixels: boolean): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const chunks = [pngChunk("IHDR", header)];
  if (withPixels) chunks.push(pngChunk("IDAT", deflateSync(new Uint8Array([0, 0, 0, 0, 0]))));
  chunks.push(pngChunk("IEND", new Uint8Array()));
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const output = new Uint8Array(signature.byteLength + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  output.set(signature);
  let offset = signature.byteLength;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

describe("InboundImageProcessor", () => {
  test("converts JPEG, PNG, WebP, BMP and GIF to bounded quality-60 JPEG", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-bun-image-"));
    roots.push(root);
    const png = pngHeader(1, 1, true);
    const webp = await new Bun.Image(jpegFixture).resize(32, 32, { fit: "inside" }).webp().bytes();
    const fixtures = [
      ["jpeg", jpegFixture, "image/jpeg"],
      ["png", png, "image/png"],
      ["webp", webp, "image/webp"],
      ["bmp", onePixelBmp(), "image/bmp"],
      ["gif", onePixelGif, "image/gif"],
    ] as const;
    const processor = new InboundImageProcessor();
    for (const [name, bytes, mime] of fixtures) {
      const result = await processor.process({
        bytes,
        originalMime: mime,
        originalFileName: `${name}.${name}`,
        outputPath: join(root, `${name}.jpg`),
        resource: { type: "image", file_key: name },
      });
      const metadata = await new Bun.Image(result.bytes).metadata();
      expect(metadata.format).toBe("jpeg");
      expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(1_024);
      expect(result.modelBlock).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg" },
      });
      expect(result.metadata).toMatchObject({
        processed: { mime: "image/jpeg", quality: 60, progressive: false },
      });
    }
  });

  test("returns stable errors for corrupt and empty input", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-bun-image-error-"));
    roots.push(root);
    const processor = new InboundImageProcessor();
    for (const bytes of [new Uint8Array(), new Uint8Array([1, 2, 3])]) {
      try {
        await processor.process({
          bytes,
          originalMime: "image/png",
          originalFileName: "bad.png",
          outputPath: join(root, "bad.jpg"),
          resource: { type: "image", file_key: "bad" },
        });
        throw new Error("expected image failure");
      } catch (error) {
        expect(error).toBeInstanceOf(InboundImageError);
        expect((error as InboundImageError).code).toBe("ERR_IMAGE_UNKNOWN_FORMAT");
      }
    }
  });

  test("rejects an oversized canvas before decoding a pixel buffer", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-bun-image-limit-"));
    roots.push(root);
    const processor = new InboundImageProcessor();
    await expect(processor.process({
      bytes: pngHeader(10_000, 10_000, false),
      originalMime: "image/png",
      originalFileName: "huge.png",
      outputPath: join(root, "huge.jpg"),
      resource: { type: "image", file_key: "huge" },
    })).rejects.toMatchObject({ code: "ERR_IMAGE_TOO_MANY_PIXELS" });
  });
});
