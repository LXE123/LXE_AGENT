import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderDescriptor } from "./provider";
import { DeepSeekUploadIndex, writeDeepSeekCacheFile } from "./deepseek-upload-index";

export const DEEPSEEK_FILE_TTL_SECONDS = 7 * 24 * 60 * 60;
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export interface DeepSeekImage {
  key: string;
  mediaType: string;
  bytes: Uint8Array;
}

export const deepseekImage = (mediaType: string, bytes: Uint8Array): DeepSeekImage => ({
  key: hash(`${mediaType}\0${hash(bytes)}`), mediaType, bytes,
});

interface UploadFlight {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
}

export interface DeepSeekFilesOptions {
  cachePath?: string;
  imageDirectory?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  uploadTimeoutMs?: number;
}

/** Match the Responses client's endpoint and effective authentication, including gateway headers. */
function connection(descriptor: ProviderDescriptor): { url: string; headers: Headers; scope: string } {
  const endpoint = new URL(descriptor.baseURL);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/files`;
  endpoint.hash = "";
  const headers = new Headers({ Authorization: `Bearer ${descriptor.apiKey}` });
  for (const [key, value] of Object.entries(descriptor.defaultHeaders)) headers.set(key, value);
  // fetch must supply the multipart boundary, even if a gateway config specifies JSON.
  headers.delete("content-type");
  headers.delete("content-length");
  const entries = [...headers.entries()].sort(([left], [right]) => left.localeCompare(right));
  return { url: endpoint.href, headers, scope: hash(JSON.stringify([endpoint.href, entries])) };
}

const extension = (mediaType: string): string => ({
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
}[mediaType] ?? "img");

const detail = (value: string): string => value.length <= 8_192
  ? value : `${value.slice(0, 8_192)}...[omitted ${value.length - 8_192} chars]`;

/** Runtime-owned, disposable cache. It contains no API keys, image bytes, or session state. */
export class DeepSeekFilesService {
  private readonly index: DeepSeekUploadIndex;
  private readonly flights = new Map<string, UploadFlight>();

  constructor(private readonly options: DeepSeekFilesOptions = {}) {
    this.index = new DeepSeekUploadIndex(options.cachePath);
  }

  private now(): number { return Math.floor((this.options.now?.() ?? Date.now()) / 1_000); }

  async resolve(descriptor: ProviderDescriptor, image: DeepSeekImage, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const target = connection(descriptor);
    const cached = await this.index.get(target.scope, image.key, this.now());
    signal.throwIfAborted();
    if (cached) return cached.fileId;
    const key = `${target.scope}:${image.key}`;
    let flight = this.flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      flight = { controller, waiters: 0, promise: Promise.resolve().then(() => this.upload(target, image, controller.signal)) };
      this.flights.set(key, flight);
      const current = flight;
      void flight.promise.finally(() => {
        if (this.flights.get(key) === current) this.flights.delete(key);
      }).catch(() => {});
    }
    // A cancelled turn must not cancel another turn's shared upload.
    const current = flight;
    current.waiters++;
    let abort: () => void;
    return await new Promise<string>((resolve, reject) => {
      abort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      current.promise.then(resolve, reject);
    }).finally(() => {
      signal.removeEventListener("abort", abort);
      if (--current.waiters === 0) current.controller.abort(new DOMException("No upload waiters", "AbortError"));
    });
  }

  private async upload(
    target: ReturnType<typeof connection>, image: DeepSeekImage, parent: AbortSignal,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.uploadTimeoutMs ?? 60_000);
    const signal = AbortSignal.any([parent, timeout]);
    signal.throwIfAborted();
    const form = new FormData();
    form.set("purpose", "user_data");
    form.set("expires_after[anchor]", "created_at");
    form.set("expires_after[seconds]", String(DEEPSEEK_FILE_TTL_SECONDS));
    form.set("file", new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mediaType }), `${image.key}.${extension(image.mediaType)}`);
    const response = await (this.options.fetch ?? globalThis.fetch)(target.url, {
      method: "POST", headers: target.headers, body: form, signal, redirect: "error",
    });
    const raw = await response.text();
    signal.throwIfAborted();
    if (!response.ok) throw Object.assign(new Error(`DeepSeek Files HTTP ${response.status}: ${detail(raw)}`), { status: response.status });
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw); } catch {
      throw new Error(`Invalid DeepSeek Files response JSON: ${detail(raw)}`);
    }
    const created = Number(value?.created_at);
    const expires = value?.expires_at === undefined ? created + DEEPSEEK_FILE_TTL_SECONDS : Number(value.expires_at);
    if (!value || typeof value.id !== "string" || !/^file-[A-Za-z0-9_-]+$/u.test(value.id)
      || value.object !== "file" || value.purpose !== "user_data" || value.bytes !== image.bytes.byteLength
      || !Number.isSafeInteger(created) || created <= 0 || !Number.isSafeInteger(expires)
      || expires <= this.now() + 3_600) {
      throw new Error(`Invalid DeepSeek Files response metadata: ${detail(raw)}`);
    }
    return await this.index.commit({ scope: target.scope, imageKey: image.key, fileId: value.id,
      bytes: image.bytes.byteLength, createdAt: created, expiresAt: expires }, this.now(), signal);
  }

  /** Compare-and-delete avoids evicting a replacement uploaded by another request. */
  async invalidate(descriptor: ProviderDescriptor, image: DeepSeekImage, fileId: string, signal?: AbortSignal): Promise<void> {
    await this.index.invalidate(connection(descriptor).scope, image.key, fileId, signal);
  }

  /** Preserve the exact historical bytes; the original screenshot path may have been overwritten. */
  async recoveryPath(image: DeepSeekImage): Promise<string | undefined> {
    if (!this.options.imageDirectory) return undefined;
    await mkdir(this.options.imageDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.options.imageDirectory, `${image.key}.${extension(image.mediaType)}`);
    try { if ((await stat(path)).size === image.bytes.byteLength) return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeDeepSeekCacheFile(path, image.bytes);
    return path;
  }

  close(): void {
    for (const flight of this.flights.values()) flight.controller.abort(new DOMException("Files service closed", "AbortError"));
    this.flights.clear();
  }
}
