import {
  accessSync,
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DashboardRpcError, type DesktopDraftAttachmentPayload } from "@lxe/desktop-protocol";
import { MAX_CONVERSATION_SCREENSHOTS, MAX_SCREENSHOT_BYTES } from "../conversation-paste";

const DEFAULT_TTL_MS = 30 * 60 * 1_000;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type StagedConversationAttachment = DesktopDraftAttachmentPayload & {
  path: string;
  expires_at: number;
  origin: "reference" | "screenshot";
};

export interface ScreenshotStorage {
  directory: string;
  prepare(bytes: Uint8Array): { png: Uint8Array; preview: string };
}

const invalidAttachment = (message: string): never => {
  throw new DashboardRpcError("invalid_argument", message);
};

export class DesktopConversationAttachmentService {
  private readonly staged = new Map<string, StagedConversationAttachment>();
  private readonly sending = new Map<string, { discardRequested: boolean }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly screenshots?: ScreenshotStorage,
  ) {}

  register(paths: readonly string[]): DesktopDraftAttachmentPayload[] {
    this.prune();
    // Validate the complete batch before publishing any draft IDs.
    const files = [...new Map(paths.map((path) => {
      const file = this.inspect(path);
      return [file.path, file] as const;
    })).values()];
    const selected: StagedConversationAttachment[] = [];
    for (const file of files) {
      const staged: StagedConversationAttachment = {
        attachment_id: randomUUID(),
        name: basename(file.path),
        size_bytes: file.size,
        media_type: file.mediaType,
        path: file.path,
        origin: "reference",
        reference_key: createHash("sha256").update(file.path).digest("hex"),
        expires_at: this.now() + this.ttlMs,
      };
      this.staged.set(staged.attachment_id, staged);
      selected.push(staged);
    }
    return selected.map((item) => this.public(item));
  }

  registerPaste(input: unknown): DesktopDraftAttachmentPayload[] {
    if (!input || typeof input !== "object") return invalidAttachment("Invalid clipboard payload");
    const { paths, images } = input as { paths?: unknown; images?: unknown };
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")
      || !Array.isArray(images) || (paths.length > 0 && images.length > 0)) {
      return invalidAttachment("Clipboard payload must contain either file paths or images");
    }
    if (paths.length) return this.register(paths);
    this.prune();
    if (images.length === 0 || images.length > MAX_CONVERSATION_SCREENSHOTS) return invalidAttachment("Paste must contain between 1 and 5 screenshots");
    for (const image of images) {
      if (!(image instanceof Uint8Array) || image.byteLength === 0 || image.byteLength > MAX_SCREENSHOT_BYTES) {
        return invalidAttachment("Screenshot must contain between 1 byte and 20 MiB");
      }
    }
    if (!this.screenshots) return invalidAttachment("Screenshot storage is unavailable");
    const storage = this.screenshots;
    const selected: StagedConversationAttachment[] = [];
    const written: string[] = [];
    try {
      mkdirSync(storage.directory, { recursive: true });
      for (const image of images) {
        const prepared = storage.prepare(image);
        if (prepared.png.byteLength === 0 || prepared.png.byteLength > MAX_SCREENSHOT_BYTES) {
          invalidAttachment("Saved screenshot exceeds the 20 MiB limit");
        }
        const id = randomUUID();
        const path = join(storage.directory, `${id}.png`);
        const descriptor = openSync(path, "wx", 0o600);
        written.push(path);
        try { writeFileSync(descriptor, prepared.png); } finally { closeSync(descriptor); }
        selected.push({
          attachment_id: id, name: basename(path), size_bytes: prepared.png.byteLength,
          media_type: "image/png", path, origin: "screenshot",
          preview_data_url: prepared.preview, expires_at: this.now() + this.ttlMs,
        });
      }
    } catch (cause) {
      for (const path of written) this.removeScreenshot(path);
      throw cause;
    }
    for (const item of selected) this.staged.set(item.attachment_id, item);
    return selected.map((item) => this.public(item));
  }

  resolve(attachmentIds: readonly string[]): StagedConversationAttachment[] {
    this.prune();
    if (attachmentIds.length === 0) invalidAttachment("At least one attachment is required");
    if (new Set(attachmentIds).size !== attachmentIds.length) invalidAttachment("Duplicate attachment IDs are not allowed");
    const items = attachmentIds.map((attachmentId): StagedConversationAttachment => {
      const item = this.staged.get(attachmentId);
      if (!item) return invalidAttachment("An attachment expired or is no longer available");
      const current = this.inspect(item.path);
      if (item.origin === "screenshot" && current.size > MAX_SCREENSHOT_BYTES) invalidAttachment("Screenshot exceeds the 20 MiB limit");
      return {
        ...item,
        name: basename(current.path),
        size_bytes: current.size,
        media_type: current.mediaType,
        path: current.path,
      };
    });
    if (items.filter((item) => item.origin === "screenshot").length > MAX_CONVERSATION_SCREENSHOTS) {
      invalidAttachment("You can paste at most 5 screenshots per turn");
    }
    return items;
  }

  consume(attachmentIds: readonly string[]): void {
    for (const attachmentId of attachmentIds) {
      this.sending.delete(attachmentId);
      this.staged.delete(attachmentId);
    }
  }

  /** Keep screenshots alive while the gateway asynchronously admits a message. */
  beginSend(attachmentIds: readonly string[]): StagedConversationAttachment[] {
    if (attachmentIds.some((id) => this.sending.has(id))) invalidAttachment("Attachment is already being submitted");
    const items = this.resolve(attachmentIds);
    for (const id of attachmentIds) this.sending.set(id, { discardRequested: false });
    return items;
  }

  finishSend(attachmentIds: readonly string[]): void {
    for (const id of attachmentIds) {
      const pending = this.sending.get(id);
      this.sending.delete(id);
      if (pending?.discardRequested) this.discard([id]);
    }
  }

  discard(attachmentIds: readonly string[]): void {
    if (attachmentIds.some((id) => typeof id !== "string" || !id.trim())) invalidAttachment("Invalid attachment ID");
    for (const attachmentId of attachmentIds) {
      const pending = this.sending.get(attachmentId);
      if (pending) {
        pending.discardRequested = true;
        continue;
      }
      const item = this.staged.get(attachmentId);
      if (item?.origin === "screenshot") this.removeScreenshot(item.path);
      this.staged.delete(attachmentId);
    }
  }

  clear(): void {
    this.discard([...this.staged.keys()]);
  }

  private inspect(inputPath: string): { path: string; size: number; mediaType: string } {
    if (typeof inputPath !== "string" || !inputPath.trim()) invalidAttachment("Invalid file path");
    const path = resolve(inputPath);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) invalidAttachment("Symbolic links cannot be attached");
    if (!stat.isFile()) invalidAttachment("Only regular files can be attached");
    const extension = extname(path).toLowerCase();
    const mediaType = MEDIA_TYPES[extension] ?? "application/octet-stream";
    accessSync(path, constants.R_OK);
    return { path: realpathSync(path), size: stat.size, mediaType };
  }

  private prune(): void {
    const now = this.now();
    for (const [attachmentId, item] of this.staged) {
      if (item.expires_at <= now && !this.sending.has(attachmentId)) this.discard([attachmentId]);
    }
  }

  private removeScreenshot(path: string): void {
    try { unlinkSync(path); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  private public(item: StagedConversationAttachment): DesktopDraftAttachmentPayload {
    return {
      attachment_id: item.attachment_id,
      name: item.name,
      size_bytes: item.size_bytes,
      media_type: item.media_type,
      ...(item.preview_data_url ? { preview_data_url: item.preview_data_url } : {}),
      ...(item.reference_key ? { reference_key: item.reference_key } : {}),
    };
  }
}
