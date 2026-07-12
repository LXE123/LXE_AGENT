import { InboundImageProcessor } from "./feishu/image";

const inputPath = String(Bun.argv[2] ?? "").trim();
const outputPath = String(Bun.argv[3] ?? "").trim();
if (!inputPath || !outputPath) throw new Error("usage: image-compile-smoke <input-image> <output-jpeg>");

const bytes = new Uint8Array(await Bun.file(inputPath).arrayBuffer());
const result = await new InboundImageProcessor().process({
  bytes,
  originalMime: Bun.file(inputPath).type || "application/octet-stream",
  originalFileName: inputPath,
  outputPath,
  resource: { type: "image", file_key: "compiled-smoke" },
});
const metadata = await new Bun.Image(result.bytes).metadata();
process.stdout.write(`${JSON.stringify({
  format: metadata.format,
  width: metadata.width,
  height: metadata.height,
  mime: result.metadata.processed && typeof result.metadata.processed === "object"
    ? (result.metadata.processed as Record<string, unknown>).mime
    : "",
})}\n`);
