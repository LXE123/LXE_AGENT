import { writeFileSync } from "node:fs";
import type { JsonObject } from "@lxe/protocol";

export const INBOUND_IMAGE_ERROR_CODES = [
  "ERR_IMAGE_TOO_MANY_PIXELS",
  "ERR_IMAGE_FORMAT_UNSUPPORTED",
  "ERR_IMAGE_DECODE_FAILED",
  "ERR_IMAGE_ENCODE_FAILED",
  "ERR_IMAGE_UNKNOWN_FORMAT",
] as const;

export type InboundImageErrorCode = typeof INBOUND_IMAGE_ERROR_CODES[number];

export class InboundImageError extends Error {
  constructor(
    readonly code: InboundImageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InboundImageError";
  }
}

export interface InboundImageProcessRequest {
  bytes: Uint8Array;
  originalMime: string;
  originalFileName: string;
  outputPath: string;
  resource: JsonObject;
}

export interface InboundImageProcessResult {
  bytes: Uint8Array;
  modelBlock: JsonObject;
  savedPath: string;
  metadata: JsonObject;
}

const supportedInputFormats = new Set<Bun.Image.Format>(["jpeg", "png", "webp", "bmp", "gif"]);
const knownErrorCodes = new Set<string>(INBOUND_IMAGE_ERROR_CODES);

const errorCode = (cause: unknown, fallback: InboundImageErrorCode): InboundImageErrorCode => {
  if (cause instanceof InboundImageError) return cause.code;
  if (cause !== null && typeof cause === "object") {
    const code = String((cause as { code?: unknown }).code ?? "").trim();
    if (knownErrorCodes.has(code)) return code as InboundImageErrorCode;
  }
  return fallback;
};

const imageError = (
  cause: unknown,
  fallback: InboundImageErrorCode,
  stage: string,
): InboundImageError => {
  if (cause instanceof InboundImageError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new InboundImageError(errorCode(cause, fallback), `${stage}: ${message}`, { cause });
};

export class InboundImageProcessor {
  async process(request: InboundImageProcessRequest): Promise<InboundImageProcessResult> {
    if (request.bytes.byteLength === 0) {
      throw new InboundImageError("ERR_IMAGE_UNKNOWN_FORMAT", "image input is empty");
    }
    const image = new Bun.Image(request.bytes, {
      autoOrient: true,
      maxPixels: 40_000_000,
    });
    let original: Bun.Image.Metadata;
    try {
      original = await image.metadata();
    } catch (cause) {
      throw imageError(cause, "ERR_IMAGE_DECODE_FAILED", "image metadata failed");
    }
    if (!supportedInputFormats.has(original.format)) {
      throw new InboundImageError(
        "ERR_IMAGE_FORMAT_UNSUPPORTED",
        `unsupported inbound image format: ${original.format}`,
      );
    }
    if (Math.max(original.width, original.height) > 1_024) {
      image.resize(1_024, 1_024, {
        fit: "inside",
        withoutEnlargement: true,
        filter: "lanczos3",
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = await image.jpeg({ quality: 60, progressive: false }).bytes();
    } catch (cause) {
      throw imageError(cause, "ERR_IMAGE_ENCODE_FAILED", "image JPEG encode failed");
    }
    let processed: Bun.Image.Metadata;
    try {
      processed = await new Bun.Image(bytes, { maxPixels: 40_000_000 }).metadata();
    } catch (cause) {
      throw imageError(cause, "ERR_IMAGE_ENCODE_FAILED", "encoded JPEG verification failed");
    }
    writeFileSync(request.outputPath, bytes);
    const metadata: JsonObject = {
      ...request.resource,
      saved_path: request.outputPath,
      original: {
        mime: request.originalMime,
        format: original.format,
        width: original.width,
        height: original.height,
        size_bytes: request.bytes.byteLength,
        file_name: request.originalFileName,
      },
      processed: {
        mime: "image/jpeg",
        format: processed.format,
        width: processed.width,
        height: processed.height,
        size_bytes: bytes.byteLength,
        quality: 60,
        progressive: false,
      },
      download_status: "success",
      processing_status: "success",
    };
    return {
      bytes,
      modelBlock: {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: Buffer.from(bytes).toString("base64"),
        },
      },
      savedPath: request.outputPath,
      metadata,
    };
  }
}
