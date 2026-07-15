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

export interface InboundImageProcessorPort {
  process(request: InboundImageProcessRequest): Promise<InboundImageProcessResult>;
}
