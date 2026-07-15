import { writeFileSync } from "node:fs";
import type { JsonObject } from "@lxe/protocol";
import { ModelImageError, ModelImageProcessor } from "@lxe/runtime";
import {
  INBOUND_IMAGE_ERROR_CODES,
  InboundImageError,
  type InboundImageErrorCode,
  type InboundImageProcessRequest,
  type InboundImageProcessResult,
  type InboundImageProcessorPort,
} from "./image-contract";

export * from "./image-contract";

const knownErrorCodes = new Set<string>(INBOUND_IMAGE_ERROR_CODES);

const errorCode = (cause: unknown, fallback: InboundImageErrorCode): InboundImageErrorCode => {
  if (cause instanceof InboundImageError) return cause.code;
  if (cause instanceof ModelImageError && knownErrorCodes.has(cause.code)) return cause.code as InboundImageErrorCode;
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

export class InboundImageProcessor implements InboundImageProcessorPort {
  private readonly processor = new ModelImageProcessor();

  async process(request: InboundImageProcessRequest): Promise<InboundImageProcessResult> {
    let prepared;
    try {
      prepared = await this.processor.process(request.bytes, "feishu");
    } catch (cause) {
      throw imageError(cause, "ERR_IMAGE_DECODE_FAILED", "inbound image processing failed");
    }
    writeFileSync(request.outputPath, prepared.bytes);
    const metadata: JsonObject = {
      ...request.resource,
      saved_path: request.outputPath,
      original: {
        mime: request.originalMime,
        format: prepared.original.format,
        width: prepared.original.width,
        height: prepared.original.height,
        size_bytes: request.bytes.byteLength,
        file_name: request.originalFileName,
      },
      processed: {
        mime: "image/jpeg",
        format: prepared.processed.format,
        width: prepared.processed.width,
        height: prepared.processed.height,
        size_bytes: prepared.bytes.byteLength,
        quality: 60,
        progressive: false,
      },
      download_status: "success",
      processing_status: "success",
    };
    return {
      bytes: prepared.bytes,
      modelBlock: {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: Buffer.from(prepared.bytes).toString("base64"),
        },
      },
      savedPath: request.outputPath,
      metadata,
    };
  }
}
