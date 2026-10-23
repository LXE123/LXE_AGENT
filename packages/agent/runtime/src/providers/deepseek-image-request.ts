import { createLogger } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";
import { deepseekImage, type DeepSeekImage, type DeepSeekFilesService } from "./deepseek-files";
import { normalizeProviderError, RuntimeProviderError, type ProviderDescriptor } from "./provider";

const logger = createLogger("runtime.deepseek_images");
const MiB = 1024 * 1024;
export const DEEPSEEK_IMAGE_LIMITS = {
  fileBytes: 128 * MiB, inlineBytes: 20 * MiB, images: 600,
  fileRemovalBytes: 64 * MiB, inlineRemovalBytes: 10 * MiB, removalImages: 20,
  bodyBytes: 48 * MiB,
};

export const usesDeepSeekImages = (descriptor: ProviderDescriptor): boolean =>
  descriptor.name === "deepseek" && descriptor.apiStyle === "openai_responses" && descriptor.supportsVision === true;

interface Occurrence {
  parts: JsonObject[];
  index: number;
  original: JsonObject;
  image: DeepSeekImage;
  inlineBytes: number;
  omitted: boolean;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Request-local projection only: no file ids or omission decisions enter shared history. */
export class DeepSeekImageRequest {
  private readonly images: Occurrence[] = [];
  private used: Array<{ image: DeepSeekImage; fileId: string }> = [];
  private retried = false;
  private inline = false;

  constructor(
    private readonly descriptor: ProviderDescriptor,
    private readonly files: DeepSeekFilesService,
    private readonly parameters: Record<string, unknown>,
    private readonly signal: AbortSignal,
    private readonly diagnostic: (event: string, payload: JsonObject) => void = () => {},
    private readonly limits = DEEPSEEK_IMAGE_LIMITS,
  ) {
    const versions = new Map<string, DeepSeekImage>();
    // Only provider image parts are walked. Tool arguments and arbitrary JSON are not images.
    for (const item of parameters.input as JsonObject[]) {
      const parts = item.type === "function_call_output" ? item.output : item.content;
      if (!Array.isArray(parts)) continue;
      for (const [index, raw] of parts.entries()) {
        const part = raw as JsonObject;
        if (part.type !== "input_image" || typeof part.image_url !== "string") continue;
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(part.image_url);
        if (!match) throw new Error("Invalid DeepSeek inline image data");
        let image = versions.get(part.image_url);
        if (!image) {
          image = deepseekImage(match[1]!, Buffer.from(match[2]!, "base64"));
          versions.set(part.image_url, image);
        }
        this.images.push({ parts: parts as JsonObject[], index, original: part, image,
          inlineBytes: match[2]!.length, omitted: false });
      }
    }
  }

  get omittedCount(): number { return this.images.filter(image => image.omitted).length; }

  private async omit(occurrence: Occurrence): Promise<void> {
    this.signal.throwIfAborted();
    let path: string | undefined;
    try { path = await this.files.recoveryPath(occurrence.image); }
    catch (error) { logger.warn("image_recovery_copy_failed", { image: occurrence.image.key, error }); }
    this.signal.throwIfAborted();
    occurrence.parts[occurrence.index] = { type: "input_text", text:
      `[Image omitted from this DeepSeek request to fit image/body limits; sha256:${occurrence.image.key}. `
      + (path ? `Exact historical image copy: ${JSON.stringify(path)}. Read it again with the image tool if needed.`
        : "The original image remains in conversation history; ask the user to attach it again if needed.") + "]" };
    occurrence.omitted = true;
  }

  private async fitImages(inline: boolean): Promise<void> {
    const retained = this.images.filter(image => !image.omitted);
    const size = (image: Occurrence): number => inline ? image.inlineBytes : image.image.bytes.byteLength;
    const limit = inline ? this.limits.inlineBytes : this.limits.fileBytes;
    const quantum = inline ? this.limits.inlineRemovalBytes : this.limits.fileRemovalBytes;
    const total = retained.reduce((sum, image) => sum + size(image), 0);
    const removeBytes = Math.ceil(Math.max(0, total - limit) / quantum) * quantum;
    const removeCount = Math.ceil(Math.max(0, retained.length - this.limits.images) / this.limits.removalImages) * this.limits.removalImages;
    let removed = 0;
    let count = 0;
    for (const occurrence of retained) {
      if (removed >= removeBytes && count >= removeCount) break;
      await this.omit(occurrence);
      removed += size(occurrence);
      count++;
    }
  }

  private async fitBody(): Promise<void> {
    let bytes = jsonBytes(this.parameters);
    for (const occurrence of this.images) {
      if (bytes <= this.limits.bodyBytes) break;
      if (occurrence.omitted) continue;
      const before = jsonBytes(occurrence.parts[occurrence.index]);
      await this.omit(occurrence);
      bytes += jsonBytes(occurrence.parts[occurrence.index]) - before;
    }
    if (bytes > this.limits.bodyBytes) throw new RuntimeProviderError(
      `DeepSeek request body is ${bytes} bytes after omitting all images; limit is ${this.limits.bodyBytes} bytes`,
      this.descriptor.name, "请求体过大", "DeepSeek 请求体超过字节上限，省略图片后仍过大，请压缩文字和工具历史。", false, 413,
    );
    this.diagnostic("deepseek.image_projection", { mode: this.inline ? "base64" : "files",
      images: this.images.length, omitted: this.omittedCount, body_bytes: bytes });
  }

  async prepare(): Promise<void> {
    this.signal.throwIfAborted();
    this.used = [];
    await this.fitImages(this.inline);
    if (!this.inline) {
      try {
        const resolved = new Map<string, string>();
        for (const occurrence of this.images) {
          if (occurrence.omitted) continue;
          const image = occurrence.image;
          const fileId = resolved.get(image.key) ?? await this.files.resolve(this.descriptor, image, this.signal);
          resolved.set(image.key, fileId);
          occurrence.parts[occurrence.index] = { type: "input_image", file_id: fileId };
          this.used.push({ image, fileId });
        }
      } catch (error) {
        this.signal.throwIfAborted();
        // Preserve the real upload failure in diagnostics, then apply a bounded, request-wide fallback.
        logger.warn("files_inline_fallback", { error });
        this.diagnostic("deepseek.files_fallback", { error: error instanceof Error ? error.message : String(error) });
        this.inline = true;
        this.used = [];
        for (const occurrence of this.images) {
          if (!occurrence.omitted) occurrence.parts[occurrence.index] = occurrence.original;
        }
        await this.fitImages(true);
      }
    }
    this.signal.throwIfAborted();
    await this.fitBody();
    const retainedKeys = new Set(this.images.filter(image => !image.omitted).map(image => image.image.key));
    this.used = this.used.filter(entry => retainedKeys.has(entry.image.key));
  }

  /** Retry an explicitly rejected file generation once; never replay auth/413/network failures here. */
  async retry(error: unknown): Promise<boolean> {
    if (this.used.length === 0 || this.signal.aborted) return false;
    const failure = normalizeProviderError(error, this.descriptor);
    if (![400, 404, 410, 422].includes(failure.statusCode ?? 0)) return false;
    const detail = failure.message;
    const file = /\bfile(?:[_ -]?(?:id|api|not[_ -]?found|deleted|expired))?/iu.test(detail);
    const missing = /(?:expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account)/iu.test(detail);
    const invalid = /(?:invalid.{0,20}file[_ -]?(?:id|api)|file[_ -]?(?:id|api).{0,20}invalid)/iu.test(detail);
    if (!file || (!missing && !invalid)) return false;
    const unique = [...new Map(this.used.map(entry => [entry.image.key, entry])).values()];
    const named = unique.filter(entry => new RegExp(`(?<![A-Za-z0-9_-])${entry.fileId}(?![A-Za-z0-9_-])`, "u").test(detail));
    try {
      for (const entry of named.length ? named : unique) {
        await this.files.invalidate(this.descriptor, entry.image, entry.fileId, this.signal);
      }
    } catch (cause) {
      this.signal.throwIfAborted();
      logger.warn("file_invalidation_failed", { error: cause });
      return false;
    }
    if (this.retried) return false;
    this.retried = true;
    this.diagnostic("deepseek.files_retry", { error: failure.message });
    return true;
  }
}
