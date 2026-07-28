import {
  type BigIntStats,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, relative } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { detectReadImageMime, type ModelImageProcessor } from "../../providers/model-image";
import { scanNumberedTextChunks, type NumberedTextRangeResult } from "../text-range";
import type { ToolDefinition } from "../registry";
import { isProbablyBinary } from "../workspace-search";
import {
  type FileVersion,
  FileVersionLedger,
  fileVersionFromStats,
} from "./file-version-ledger";
import type { CodingPathPolicy } from "./path-policy";

const BINARY_EXTENSIONS = new Set([
  ".pyc", ".pyo", ".exe", ".dll", ".so", ".bin", ".zip", ".tar", ".gz", ".7z", ".rar", ".whl",
  ".pdf", ".xlsx", ".xlsm", ".xltx", ".xltm", ".xls", ".docx", ".docm", ".dotx", ".dotm",
  ".doc", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppt", ".odt", ".ods", ".odp",
]);

const SMALL_READ_BYTES = 512 * 1_024;
const READ_CHUNK_BYTES = 256 * 1_024;
const DEFAULT_LARGE_READ_LINES = 2_000;
const READ_HINT_CHAR_RESERVE = 160;

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

const truncateHeadTail = (value: string, limit: number): { value: string; truncated: boolean } => {
  if (value.length <= limit) return { value, truncated: false };
  const marker = `\n... (truncated, ${value.length} chars total) ...\n`;
  const available = Math.max(2, limit - marker.length);
  const head = Math.floor(available / 2);
  return { value: `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`, truncated: true };
};

const abortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ?? new DOMException("Aborted", "AbortError");

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortReason(signal);
};

const readHeadBytes = async (path: string, count: number, signal?: AbortSignal): Promise<Buffer> => {
  assertActive(signal);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    assertActive(signal);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const readNumberedRange = async (
  path: string,
  startLine: number,
  maxLines: number,
  charBudget: number,
  signal?: AbortSignal,
): Promise<NumberedTextRangeResult> => {
  assertActive(signal);
  const handle = await open(path, "r");
  try {
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (true) {
        assertActive(signal);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        assertActive(signal);
        if (bytesRead === 0) return;
        yield buffer.subarray(0, bytesRead);
      }
    };
    return await scanNumberedTextChunks(chunks(), { startLine, maxLines, charBudget, ...(signal ? { signal } : {}) });
  } finally {
    await handle.close();
  }
};

const assertFileVersionUnchanged = async (path: string, expected: FileVersion): Promise<void> => {
  let actual: FileVersion | undefined;
  try {
    actual = fileVersionFromStats(await stat(path, { bigint: true }));
  } catch {
    // Treated as a version change.
  }
  if (actual !== expected) {
    throw new Error(`read 期间文件发生变化，请重新读取最新内容: ${path}`);
  }
};

export interface FileToolDependencies {
  paths: CodingPathPolicy;
  ledger: FileVersionLedger;
  imageProcessor: ModelImageProcessor;
  toolOutputLimit: number;
  attachmentPaths?: (sessionId: string) => Promise<readonly string[]>;
}

export function createFileTools(dependencies: FileToolDependencies): ToolDefinition[] {
  const { paths, ledger, imageProcessor, toolOutputLimit } = dependencies;
  return [
    {
      name: "read",
      description: "Read a text or image file from the workspace, bundled skills, runtime artifacts, the configured user Skill root, or an exact local file attached to this conversation. External roots are read-only. Reading records the file version required by edit/write.",
      input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false },
      execute: async (input, context) => {
        const attachmentPaths = await dependencies.attachmentPaths?.(context.session_id) ?? [];
        const path = paths.resolveReadable(context.workspace, input.path, attachmentPaths).path;
        let info: BigIntStats;
        try {
          info = await stat(path, { bigint: true });
        } catch {
          throw new Error(`file not found: ${input.path}`);
        }
        if (!info.isFile()) throw new Error(`file not found: ${input.path}`);
        const version = fileVersionFromStats(info);
        if (basename(path).toLowerCase() === "skill.md") {
          await context.exposureState?.activateSkill(basename(dirname(path)));
        }
        const head = await readHeadBytes(path, 4_100, context.handle.signal);
        if (detectReadImageMime(head)) {
          const data = await readFile(path, { signal: context.handle.signal });
          await assertFileVersionUnchanged(path, version);
          const prepared = await imageProcessor.process(data, "read");
          assertActive(context.handle.signal);
          ledger.recordVersion(context.session_id, path, version);
          const scale = prepared.processed.width > 0 ? prepared.original.width / prepared.processed.width : 1;
          return {
            content: [
              {
                type: "text",
                text: `Read image file [${prepared.mediaType}]\n[Image: original ${prepared.original.width}x${prepared.original.height}, displayed at ${prepared.processed.width}x${prepared.processed.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`,
              },
              { type: "image", source: { type: "base64", media_type: prepared.mediaType, data: Buffer.from(prepared.bytes).toString("base64") } },
            ],
          };
        }
        const extension = extname(path).toLowerCase();
        if (BINARY_EXTENSIONS.has(extension)) throw new Error(`binary file cannot be read as text: ${input.path}`);
        if (isProbablyBinary(head)) throw new Error(`binary file cannot be read as text: ${input.path}`);
        const start = Math.max(1, Number(input.offset ?? 1));
        if (info.size <= BigInt(SMALL_READ_BYTES)) {
          const data = await readFile(path, { signal: context.handle.signal });
          await assertFileVersionUnchanged(path, version);
          assertActive(context.handle.signal);
          const lines = data.toString("utf8").split(/\r?\n/);
          const count = Math.max(1, Number(input.limit ?? lines.length));
          const body = lines.slice(start - 1, start - 1 + count)
            .map((line, index) => `${String(start + index).padStart(6, " ")}\t${line}`).join("\n");
          ledger.recordVersion(context.session_id, path, version);
          return { content: textBlock(truncateHeadTail(body, toolOutputLimit).value) };
        }
        const count = Math.max(1, Number(input.limit ?? DEFAULT_LARGE_READ_LINES));
        const range = await readNumberedRange(
          path,
          start,
          count,
          Math.max(1, toolOutputLimit - READ_HINT_CHAR_RESERVE),
          context.handle.signal,
        );
        await assertFileVersionUnchanged(path, version);
        assertActive(context.handle.signal);
        ledger.recordVersion(context.session_id, path, version);
        const hint = range.truncatedLine === undefined
          ? range.hasMore && range.nextOffset !== undefined
            ? `... (更多内容，使用 offset=${range.nextOffset} 继续)`
            : ""
          : `... (第 ${range.truncatedLine} 行超过 ${toolOutputLimit} 字符读取上限；请使用 exec 的字节工具读取该超长行)`;
        if (!hint) return { content: textBlock(range.body) };
        const separator = range.body ? "\n" : "";
        const bodyLimit = Math.max(0, toolOutputLimit - separator.length - hint.length);
        return { content: textBlock(`${range.body.slice(0, bodyLimit)}${separator}${hint}`) };
      },
    },
    {
      name: "write",
      description: "Create or overwrite a UTF-8 file inside the workspace.",
      input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"], additionalProperties: false },
      execute: async (input, context) => {
        const path = paths.resolveWritable(context.workspace, input.file_path);
        if (existsSync(path)) {
          if (!statSync(path).isFile()) throw new Error(`path is not a regular file: ${input.file_path}`);
          ledger.assertCurrent(context.session_id, path, "write");
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, inputText(input, "content"), "utf8");
        ledger.recordCurrent(context.session_id, path);
        return { content: textBlock(`Wrote ${relative(context.workspace.directory, path)}`) };
      },
    },
    {
      name: "edit",
      description: "Replace exact text in a workspace file.",
      input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"], additionalProperties: false },
      execute: async (input, context) => {
        const path = paths.resolveWritable(context.workspace, input.file_path);
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`file not found: ${input.file_path}`);
        ledger.assertCurrent(context.session_id, path, "edit");
        const source = readFileSync(path, "utf8");
        const oldText = inputText(input, "old_string");
        if (!oldText) throw new Error("old_string must not be empty");
        const occurrences = source.split(oldText).length - 1;
        if (occurrences === 0) throw new Error("old_string not found");
        if (!input.replace_all && occurrences !== 1) throw new Error("old_string is not unique");
        const updated = input.replace_all
          ? source.replaceAll(oldText, inputText(input, "new_string"))
          : source.replace(oldText, inputText(input, "new_string"));
        writeFileSync(path, updated, "utf8");
        ledger.recordCurrent(context.session_id, path);
        return { content: textBlock(`Edited ${relative(context.workspace.directory, path)}`) };
      },
    },
  ];
}
