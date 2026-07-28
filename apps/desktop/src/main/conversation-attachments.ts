import {
  lstatSync,
  realpathSync,
} from "node:fs";
import { basename, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DashboardRpcError, type DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
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

export const CONVERSATION_FILE_EXTENSIONS = Object.keys(MEDIA_TYPES).map((extension) => extension.slice(1));

export type StagedConversationAttachment = DesktopInputAttachmentPayload & {
  path: string;
  expires_at: number;
};

const invalidAttachment = (message: string): never => {
  throw new DashboardRpcError("invalid_argument", message);
};

export class DesktopConversationAttachmentService {
  private readonly staged = new Map<string, StagedConversationAttachment>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  register(paths: readonly string[]): DesktopInputAttachmentPayload[] {
    this.prune();
    if (paths.length > MAX_FILES) invalidAttachment(`You can attach at most ${MAX_FILES} files per turn`);
    const byPath = new Map([...this.staged.values()].map((item) => [item.path, item]));
    const selected: StagedConversationAttachment[] = [];
    const selectedPaths = new Set<string>();
    for (const inputPath of paths) {
      const file = this.inspect(inputPath);
      if (selectedPaths.has(file.path)) continue;
      selectedPaths.add(file.path);
      const existing = byPath.get(file.path);
      if (existing) {
        selected.push(existing);
        continue;
      }
      const staged: StagedConversationAttachment = {
        attachment_id: randomUUID(),
        name: basename(file.path),
        size_bytes: file.size,
        media_type: file.mediaType,
        path: file.path,
        expires_at: this.now() + this.ttlMs,
      };
      this.staged.set(staged.attachment_id, staged);
      byPath.set(staged.path, staged);
      selected.push(staged);
    }
    if (selected.length > MAX_FILES) invalidAttachment(`You can attach at most ${MAX_FILES} files per turn`);
    return selected.map((item) => this.public(item));
  }

  resolve(attachmentIds: readonly string[]): StagedConversationAttachment[] {
    this.prune();
    if (attachmentIds.length === 0 || attachmentIds.length > MAX_FILES) {
      invalidAttachment(`A turn must contain between 1 and ${MAX_FILES} attachments`);
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) invalidAttachment("Duplicate attachment IDs are not allowed");
    return attachmentIds.map((attachmentId): StagedConversationAttachment => {
      const item = this.staged.get(attachmentId);
      if (!item) return invalidAttachment("An attachment expired or is no longer available");
      const current = this.inspect(item.path);
      return {
        ...item,
        name: basename(current.path),
        size_bytes: current.size,
        media_type: current.mediaType,
        path: current.path,
      };
    });
  }

  consume(attachmentIds: readonly string[]): void {
    for (const attachmentId of attachmentIds) this.staged.delete(attachmentId);
  }

  discard(attachmentIds: readonly string[]): void {
    for (const attachmentId of attachmentIds) {
      if (typeof attachmentId !== "string" || !attachmentId.trim()) invalidAttachment("Invalid attachment ID");
      this.staged.delete(attachmentId);
    }
  }

  clear(): void {
    this.staged.clear();
  }

  private inspect(inputPath: string): { path: string; size: number; mediaType: string } {
    if (typeof inputPath !== "string" || !inputPath.trim()) invalidAttachment("Invalid file path");
    const path = resolve(inputPath);
    const stat = (() => {
      try {
        return lstatSync(path);
      } catch (cause) {
        const code = String((cause as NodeJS.ErrnoException)?.code ?? "").trim();
        return invalidAttachment(`Selected file is unavailable${code ? ` (${code})` : ""}`);
      }
    })();
    if (stat.isSymbolicLink()) invalidAttachment("Symbolic links cannot be attached");
    if (!stat.isFile()) invalidAttachment("Only regular files can be attached");
    if (stat.size > MAX_FILE_BYTES) invalidAttachment("Attachment exceeds the 20 MB limit");
    const extension = extname(path).toLowerCase();
    const mediaType = MEDIA_TYPES[extension];
    if (!mediaType) return invalidAttachment(`Unsupported attachment type: ${extension || "unknown"}`);
    try {
      return { path: realpathSync(path), size: stat.size, mediaType };
    } catch (cause) {
      const code = String((cause as NodeJS.ErrnoException)?.code ?? "").trim();
      return invalidAttachment(`Selected file changed while it was being inspected${code ? ` (${code})` : ""}`);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [attachmentId, item] of this.staged) {
      if (item.expires_at <= now) this.staged.delete(attachmentId);
    }
  }

  private public(item: StagedConversationAttachment): DesktopInputAttachmentPayload {
    return {
      attachment_id: item.attachment_id,
      name: item.name,
      size_bytes: item.size_bytes,
      media_type: item.media_type,
    };
  }
}
