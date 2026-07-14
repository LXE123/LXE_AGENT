export const MODEL_IMAGE_ERROR_CODES = [
  "ERR_IMAGE_TOO_MANY_PIXELS",
  "ERR_IMAGE_FORMAT_UNSUPPORTED",
  "ERR_IMAGE_DECODE_FAILED",
  "ERR_IMAGE_ENCODE_FAILED",
  "ERR_IMAGE_UNKNOWN_FORMAT",
  "ERR_IMAGE_OUTPUT_TOO_LARGE",
] as const;

export type ModelImageErrorCode = typeof MODEL_IMAGE_ERROR_CODES[number];
export type ModelImageProfile = "read" | "feishu";

export class ModelImageError extends Error {
  constructor(
    readonly code: ModelImageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelImageError";
  }
}

export interface ModelImageInfo {
  mime: string;
  format: string;
  width: number;
  height: number;
  sizeBytes: number;
  hasAlpha: boolean;
  animated: boolean;
}

export interface ModelImageResult {
  bytes: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  original: ModelImageInfo;
  processed: ModelImageInfo;
}

type EncodedFormat = "jpeg" | "png";

interface Candidate {
  bytes: Uint8Array;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

const MAX_PIXELS = 40_000_000;
const READ_MAX_WIDTH = 2_000;
const READ_MAX_HEIGHT = 2_000;
const READ_MAX_BYTES = Math.trunc(4.5 * 1024 * 1024);
const READ_JPEG_QUALITY_STEPS = [85, 70, 55, 40] as const;
const READ_SCALE_FACTORS = [0.75, 0.5, 0.35, 0.25] as const;
const supportedFormats = new Set<Bun.Image.Format>(["jpeg", "png", "webp", "bmp", "gif"]);
const knownErrorCodes = new Set<string>(MODEL_IMAGE_ERROR_CODES);

const modelError = (cause: unknown, fallback: ModelImageErrorCode, stage: string): ModelImageError => {
  if (cause instanceof ModelImageError) return cause;
  const source = cause !== null && typeof cause === "object" ? cause as { code?: unknown } : {};
  const rawCode = String(source.code ?? "");
  const code = knownErrorCodes.has(rawCode) ? rawCode as ModelImageErrorCode : fallback;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ModelImageError(code, `${stage}: ${message}`, { cause });
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  new TextDecoder().decode(bytes.subarray(offset, offset + length));

export function detectReadImageMime(bytes: Uint8Array): ModelImageInfo["mime"] | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) return "image/png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return undefined;
}

const pngHasAlpha = (bytes: Uint8Array): boolean => {
  if (bytes.length < 26) return false;
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    if (ascii(bytes, offset + 4, 4) === "tRNS") return true;
    const next = offset + 12 + length;
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }
  return false;
};

const gifFlags = (bytes: Uint8Array): { hasAlpha: boolean; animated: boolean } => {
  let hasAlpha = false;
  let frames = 0;
  for (let index = 0; index + 7 < bytes.length; index += 1) {
    if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 0x04) {
      hasAlpha ||= Boolean((bytes[index + 3] ?? 0) & 0x01);
    }
    if (bytes[index] === 0x2c) frames += 1;
  }
  return { hasAlpha, animated: frames > 1 };
};

const webpFlags = (bytes: Uint8Array): { hasAlpha: boolean; animated: boolean } => {
  const chunk = bytes.length >= 16 ? ascii(bytes, 12, 4) : "";
  if (chunk === "VP8X" && bytes.length > 20) {
    const flags = bytes[20] ?? 0;
    return { hasAlpha: Boolean(flags & 0x10), animated: Boolean(flags & 0x02) };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const packed = new DataView(bytes.buffer, bytes.byteOffset + 21, 4).getUint32(0, true);
    return { hasAlpha: Boolean((packed >>> 28) & 1), animated: false };
  }
  return { hasAlpha: false, animated: false };
};

const sourceFlags = (bytes: Uint8Array, mime: string): { hasAlpha: boolean; animated: boolean } => {
  if (mime === "image/png") return { hasAlpha: pngHasAlpha(bytes), animated: false };
  if (mime === "image/gif") return gifFlags(bytes);
  if (mime === "image/webp") return webpFlags(bytes);
  return { hasAlpha: false, animated: false };
};

const mimeForFormat = (format: string): ModelImageInfo["mime"] => {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "gif") return "image/gif";
  if (format === "webp") return "image/webp";
  return `image/${format}`;
};

const fitSize = (width: number, height: number, maxWidth: number, maxHeight: number): [number, number] => {
  const scale = Math.min(maxWidth / Math.max(1, width), maxHeight / Math.max(1, height), 1);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
};

const chooseSmallest = (candidates: Candidate[]): Candidate => {
  const candidate = [...candidates].sort((left, right) => left.bytes.byteLength - right.bytes.byteLength)[0];
  if (!candidate) throw new ModelImageError("ERR_IMAGE_ENCODE_FAILED", "no image candidate was encoded");
  return candidate;
};

const outputInfo = (candidate: Candidate, original: ModelImageInfo): ModelImageInfo => ({
  mime: candidate.mediaType,
  format: candidate.mediaType === "image/jpeg" ? "jpeg" : "png",
  width: candidate.width,
  height: candidate.height,
  sizeBytes: candidate.bytes.byteLength,
  hasAlpha: candidate.mediaType === "image/png" && original.hasAlpha,
  animated: false,
});

export class ModelImageProcessor {
  async process(bytes: Uint8Array, profile: ModelImageProfile): Promise<ModelImageResult> {
    if (bytes.byteLength === 0) throw new ModelImageError("ERR_IMAGE_UNKNOWN_FORMAT", "image input is empty");
    const readMime = detectReadImageMime(bytes);
    let image: Bun.Image;
    try {
      image = new Bun.Image(bytes, { autoOrient: true, maxPixels: MAX_PIXELS });
    } catch (cause) {
      throw modelError(cause, "ERR_IMAGE_UNKNOWN_FORMAT", "image initialization failed");
    }
    let metadata: Bun.Image.Metadata;
    try {
      metadata = await image.metadata();
    } catch (cause) {
      throw modelError(cause, "ERR_IMAGE_DECODE_FAILED", "image metadata failed");
    }
    if (!supportedFormats.has(metadata.format)) {
      throw new ModelImageError("ERR_IMAGE_FORMAT_UNSUPPORTED", `unsupported image format: ${metadata.format}`);
    }
    const mime = readMime ?? mimeForFormat(metadata.format);
    if (profile === "read" && !readMime) {
      throw new ModelImageError("ERR_IMAGE_FORMAT_UNSUPPORTED", `unsupported read image format: ${metadata.format}`);
    }
    const flags = sourceFlags(bytes, mime);
    const original: ModelImageInfo = {
      mime,
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      sizeBytes: bytes.byteLength,
      ...flags,
    };
    return profile === "read"
      ? this.prepareRead(bytes, original)
      : this.prepareFeishu(bytes, original);
  }

  private async prepareFeishu(bytes: Uint8Array, original: ModelImageInfo): Promise<ModelImageResult> {
    const [width, height] = fitSize(original.width, original.height, 1_024, 1_024);
    const candidate = await this.encode(bytes, width, height, "jpeg", 60);
    return { bytes: candidate.bytes, mediaType: candidate.mediaType, original, processed: outputInfo(candidate, original) };
  }

  private async prepareRead(bytes: Uint8Array, original: ModelImageInfo): Promise<ModelImageResult> {
    if (!original.animated
      && original.width <= READ_MAX_WIDTH
      && original.height <= READ_MAX_HEIGHT
      && bytes.byteLength <= READ_MAX_BYTES) {
      return { bytes, mediaType: original.mime as ModelImageResult["mediaType"], original, processed: { ...original } };
    }

    const [baseWidth, baseHeight] = fitSize(original.width, original.height, READ_MAX_WIDTH, READ_MAX_HEIGHT);
    const initial: Candidate[] = [await this.encode(bytes, baseWidth, baseHeight, "png")];
    if (!original.hasAlpha) initial.push(await this.encode(bytes, baseWidth, baseHeight, "jpeg", 80));
    const fittingInitial = initial.filter((candidate) => candidate.bytes.byteLength <= READ_MAX_BYTES);
    if (fittingInitial.length > 0) {
      const candidate = chooseSmallest(fittingInitial);
      return { bytes: candidate.bytes, mediaType: candidate.mediaType, original, processed: outputInfo(candidate, original) };
    }
    let smallest = chooseSmallest(initial);

    if (!original.hasAlpha) {
      for (const quality of READ_JPEG_QUALITY_STEPS) {
        const candidate = await this.encode(bytes, baseWidth, baseHeight, "jpeg", quality);
        if (candidate.bytes.byteLength < smallest.bytes.byteLength) smallest = candidate;
        if (candidate.bytes.byteLength <= READ_MAX_BYTES) {
          return { bytes: candidate.bytes, mediaType: candidate.mediaType, original, processed: outputInfo(candidate, original) };
        }
      }
    }

    for (const factor of READ_SCALE_FACTORS) {
      const width = Math.max(1, Math.round(baseWidth * factor));
      const height = Math.max(1, Math.round(baseHeight * factor));
      if (original.hasAlpha) {
        const candidate = await this.encode(bytes, width, height, "png");
        if (candidate.bytes.byteLength < smallest.bytes.byteLength) smallest = candidate;
        if (candidate.bytes.byteLength <= READ_MAX_BYTES) {
          return { bytes: candidate.bytes, mediaType: candidate.mediaType, original, processed: outputInfo(candidate, original) };
        }
        continue;
      }
      for (const quality of READ_JPEG_QUALITY_STEPS) {
        const candidate = await this.encode(bytes, width, height, "jpeg", quality);
        if (candidate.bytes.byteLength < smallest.bytes.byteLength) smallest = candidate;
        if (candidate.bytes.byteLength <= READ_MAX_BYTES) {
          return { bytes: candidate.bytes, mediaType: candidate.mediaType, original, processed: outputInfo(candidate, original) };
        }
      }
    }
    throw new ModelImageError(
      "ERR_IMAGE_OUTPUT_TOO_LARGE",
      `processed image remains above ${READ_MAX_BYTES} bytes (smallest=${smallest.bytes.byteLength})`,
    );
  }

  private async encode(
    bytes: Uint8Array,
    width: number,
    height: number,
    format: EncodedFormat,
    quality?: number,
  ): Promise<Candidate> {
    try {
      const image = new Bun.Image(bytes, { autoOrient: true, maxPixels: MAX_PIXELS });
      image.resize(width, height, { fit: "inside", withoutEnlargement: true, filter: "lanczos3" });
      const output = format === "png"
        ? await image.png({ compressionLevel: 9 }).bytes()
        : await image.jpeg({ quality: quality ?? 80, progressive: false }).bytes();
      const metadata = await new Bun.Image(output, { maxPixels: MAX_PIXELS }).metadata();
      return {
        bytes: output,
        mediaType: format === "jpeg" ? "image/jpeg" : "image/png",
        width: metadata.width,
        height: metadata.height,
      };
    } catch (cause) {
      throw modelError(cause, "ERR_IMAGE_ENCODE_FAILED", `image ${format} encode failed`);
    }
  }
}
