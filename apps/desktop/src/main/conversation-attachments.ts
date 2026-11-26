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
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DashboardRpcError, type DesktopDraftAttachmentPayload } from "@lxe/desktop-protocol";
import { MAX_CONVERSATION_SCREENSHOTS, MAX_SCREENSHOT_BYTES } from "../conversation-paste";
import { pastedTextName, removePastedText } from "./pasted-text-retention";

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
  origin: "reference" | "screenshot" | "pasted-text";
};

export interface ScreenshotStorage {
  directory: string;
  prepare(bytes: Uint8Array): { png: Uint8Array; preview: string };
}

const invalidAttachment = (message: string): never => {
  throw new DashboardRpcError("invalid_argument", message);
};

/** Draft attachments live until sent, explicitly discarded, or cleared on shutdown. */
export class DesktopConversationAttachmentService {
  onDraftReleased?: () => void;
  private readonly unsentPastes = new Set<string>();
  private readonly writingPastes = new Set<string>();
  private generation = 0;
  private readonly staged = new Map<string, StagedConversationAttachment>();
  private readonly sending = new Map<string, { discardRequested: boolean }>();

  constructor(private readonly screenshots?: ScreenshotStorage, private readonly pastedTextDirectory?: string) {}

  register(paths: readonly string[]): DesktopDraftAttachmentPayload[] {
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
      };
      this.staged.set(staged.attachment_id, staged);
      selected.push(staged);
    }
    return selected.map((item) => this.public(item));
  }

  async registerTextPaste(text: unknown, name: unknown): Promise<DesktopDraftAttachmentPayload> {
    if (typeof text !== "string" || !text || typeof name !== "string"
      || !pastedTextName.test(name) || name !== name.trim()) {
      return invalidAttachment("Invalid pasted text attachment");
    }
    if (!this.pastedTextDirectory) return invalidAttachment("Text attachment storage is unavailable");
    const id = randomUUID();
    const generation = this.generation;
    await mkdir(this.pastedTextDirectory, { recursive: true });
    if (!lstatSync(this.pastedTextDirectory).isDirectory()) return invalidAttachment("Invalid pasted text directory");
    const directory = join(realpathSync(this.pastedTextDirectory), id);
    const path = join(directory, name);
    // The startup orphan sweep must not remove a paste that is not staged yet.
    this.writingPastes.add(path);
    try {
      await mkdir(directory, { mode: 0o700 });
      try {
        await writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
        if (generation !== this.generation) throw new Error("Text attachment staging was cancelled");
      } catch (cause) {
        removePastedText(this.pastedTextDirectory, path);
        throw cause;
      }
      const item: StagedConversationAttachment = {
        attachment_id: id, name, path, size_bytes: Buffer.byteLength(text), media_type: "text/plain", origin: "pasted-text",
      };
      this.unsentPastes.add(path);
      this.staged.set(id, item);
      return this.public(item);
    } finally { this.writingPastes.delete(path); }
  }

  registerPaste(input: unknown): DesktopDraftAttachmentPayload[] {
    if (!input || typeof input !== "object") return invalidAttachment("Invalid clipboard payload");
    const { paths, images } = input as { paths?: unknown; images?: unknown };
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")
      || !Array.isArray(images) || (paths.length > 0 && images.length > 0)) {
      return invalidAttachment("Clipboard payload must contain either file paths or images");
    }
    if (paths.length) return this.register(paths);
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
          preview_data_url: prepared.preview,
        });
      }
    } catch (cause) {
      for (const path of written) this.removeFile(path);
      throw cause;
    }
    for (const item of selected) this.staged.set(item.attachment_id, item);
    return selected.map((item) => this.public(item));
  }

  resolve(attachmentIds: readonly string[]): StagedConversationAttachment[] {
    if (attachmentIds.length === 0) invalidAttachment("At least one attachment is required");
    if (new Set(attachmentIds).size !== attachmentIds.length) invalidAttachment("Duplicate attachment IDs are not allowed");
    const items = attachmentIds.map((attachmentId): StagedConversationAttachment => {
      const item = this.staged.get(attachmentId);
      if (!item) return invalidAttachment("An attachment is no longer available");
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
      const item = this.staged.get(attachmentId);
      if (item) this.unsentPastes.delete(item.path);
      this.sending.delete(attachmentId);
      this.staged.delete(attachmentId);
    }
    this.releaseDiscardedText();
  }

  /** Keep staged files alive while the gateway asynchronously admits a message. */
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
      if (item?.origin === "screenshot") this.removeFile(item.path);
      this.staged.delete(attachmentId);
    }
    this.releaseDiscardedText();
  }

  isStaged(path: string): boolean {
    if (this.writingPastes.has(path)) return true;
    for (const item of this.staged.values()) if (item.path === path) return true;
    return false;
  }

  private releaseDiscardedText(): void {
    const stagedPaths = new Set([...this.staged.values()].map(item => item.path));
    for (const path of this.unsentPastes) {
      if (stagedPaths.has(path)) continue;
      if (this.pastedTextDirectory) removePastedText(this.pastedTextDirectory, path);
      this.unsentPastes.delete(path);
    }
    this.onDraftReleased?.();
  }

  clear(): void {
    this.generation++;
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

  private removeFile(path: string): void {
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
