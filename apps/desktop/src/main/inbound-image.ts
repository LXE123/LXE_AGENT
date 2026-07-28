import { writeFileSync } from "node:fs";
import { nativeImage } from "electron";
import {
  InboundImageError,
  type InboundImageProcessRequest,
  type InboundImageProcessResult,
  type InboundImageProcessorPort,
} from "@lxe/gateway/desktop";
import type { JsonObject } from "@lxe/protocol";

const MAX_PIXELS = 40_000_000;
const MAX_EDGE = 1_024;
const JPEG_QUALITY = 60;

const imageFormat = (mime: string): string => {
  const normalized = mime.trim().toLowerCase();
  const subtype = normalized.split("/", 2)[1]?.split(";", 1)[0];
  return subtype === "jpg" ? "jpeg" : (subtype || "unknown");
};

const fittedSize = (width: number, height: number): { width: number; height: number } => {
  const scale = Math.min(MAX_EDGE / Math.max(width, 1), MAX_EDGE / Math.max(height, 1), 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/** Electron-backed image preparation used by the Node.js desktop Gateway. */
export class ElectronInboundImageProcessor implements InboundImageProcessorPort {
  prepareModelBlock(bytes: Uint8Array, _originalMime: string): JsonObject {
    return this.prepare(bytes).modelBlock;
  }

  private prepare(bytes: Uint8Array): {
    encoded: Buffer;
    modelBlock: JsonObject;
    originalSize: { width: number; height: number };
    processedSize: { width: number; height: number };
  } {
    if (bytes.byteLength === 0) {
      throw new InboundImageError("ERR_IMAGE_UNKNOWN_FORMAT", "image input is empty");
    }

    const source = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (source.isEmpty()) {
      throw new InboundImageError("ERR_IMAGE_DECODE_FAILED", "Electron could not decode the image");
    }
    const originalSize = source.getSize();
    if (originalSize.width * originalSize.height > MAX_PIXELS) {
      throw new InboundImageError(
        "ERR_IMAGE_TOO_MANY_PIXELS",
        `image exceeds the ${MAX_PIXELS} pixel limit`,
      );
    }

    const target = fittedSize(originalSize.width, originalSize.height);
    const prepared = target.width === originalSize.width && target.height === originalSize.height
      ? source
      : source.resize({ ...target, quality: "best" });
    const encoded = prepared.toJPEG(JPEG_QUALITY);
    if (encoded.byteLength === 0) {
      throw new InboundImageError("ERR_IMAGE_ENCODE_FAILED", "Electron could not encode the image as JPEG");
    }
    const processedSize = prepared.getSize();
    return {
      encoded,
      originalSize,
      processedSize,
      modelBlock: {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: encoded.toString("base64"),
        },
      },
    };
  }

  async process(request: InboundImageProcessRequest): Promise<InboundImageProcessResult> {
    const prepared = this.prepare(request.bytes);
    writeFileSync(request.outputPath, prepared.encoded);
    const bytes = new Uint8Array(prepared.encoded);

    return {
      bytes,
      modelBlock: prepared.modelBlock,
      savedPath: request.outputPath,
      metadata: {
        ...request.resource,
        saved_path: request.outputPath,
        original: {
          mime: request.originalMime,
          format: imageFormat(request.originalMime),
          width: prepared.originalSize.width,
          height: prepared.originalSize.height,
          size_bytes: request.bytes.byteLength,
          file_name: request.originalFileName,
        },
        processed: {
          mime: "image/jpeg",
          format: "jpeg",
          width: prepared.processedSize.width,
          height: prepared.processedSize.height,
          size_bytes: prepared.encoded.byteLength,
          quality: JPEG_QUALITY,
          progressive: false,
        },
        download_status: "success",
        processing_status: "success",
      },
    };
  }
}
