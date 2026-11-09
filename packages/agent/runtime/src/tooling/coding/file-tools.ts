import {
  type BigIntStats,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, relative } from "node:path";
import { canonicalPathCandidate } from "@lxe/core";
import { join } from "node:path";
import { ExecutionPaths } from "../../permissions/execution-paths";
import { approveIfNeeded, requestedPolicy, permissionInputProperties, permissionToolDescription, type PermissionApprovalService } from "../../permissions/approvals";
import type { JsonObject } from "@lxe/protocol";
import { inspectFileWriteTarget, recheckFileWriteTarget, type FileWriteTarget } from "../../permissions/file-write-policy";
import { detectReadImageMime, type ModelImageProcessor } from "../../providers/model-image";
import { scanNumberedTextChunks, type NumberedTextRangeResult } from "../text-range";
import { ToolExecutionError, type ToolDefinition } from "../registry";
import { isProbablyBinary } from "../workspace-search";
import {
  type FileVersion,
  FileVersionLedger,
  fileVersionFromStats,
} from "./file-version-ledger";
import type { CodingPathPolicy } from "./path-policy";
import { editInputSchema, prepareTextEdit, summarizeTextEdit, validateEditInput } from "./edit-text";

const BINARY_EXTENSIONS = new Set([
  ".pyc", ".pyo", ".exe", ".dll", ".so", ".bin", ".zip", ".tar", ".gz", ".7z", ".rar", ".whl",
  ".pdf", ".xlsx", ".xlsm", ".xltx", ".xltm", ".xls", ".docx", ".docm", ".dotx", ".dotm",
  ".doc", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppt", ".odt", ".ods", ".odp",
]);

const READ_CHUNK_BYTES = 256 * 1_024;
const DEFAULT_READ_LINES = 2_000;
const READ_HINT_CHAR_RESERVE = 160;

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const isMissingPathError = (cause: unknown): boolean =>
  cause instanceof Error
  && "code" in cause
  && (cause.code === "ENOENT" || cause.code === "ENOTDIR");

const abortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ?? new DOMException("Aborted", "AbortError");

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortReason(signal);
};

const writeTargetVersion = ({ path, info }: FileWriteTarget): FileVersion | undefined => {
  if (!info) return undefined;
  if (!info.isFile()) throw new Error(`path is not a regular file: ${path}`);
  return fileVersionFromStats(info);
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

const readTextRange = async (
  path: string,
  startLine: number,
  maxLines: number,
  charBudget: number,
  plainText: boolean,
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
    return await scanNumberedTextChunks(chunks(), { startLine, maxLines, charBudget, plainText, ...(signal ? { signal } : {}) });
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
  executionPaths?: ExecutionPaths;
  approvals?: PermissionApprovalService;
  ledger: FileVersionLedger;
  imageProcessor: ModelImageProcessor;
  toolOutputLimit: number;
}

export function createFileTools(dependencies: FileToolDependencies): ToolDefinition[] {
  const { paths, ledger, imageProcessor, toolOutputLimit } = dependencies;
  const executionPaths = dependencies.executionPaths ?? new ExecutionPaths(join(process.cwd(), "var"));
  const tools: ToolDefinition[] = [
    {
      name: "read",
      codemodeResult: "text-or-image",
      description: "Read any text or image file accessible to the local LXE Agent process. Relative paths resolve from the session working directory. Reading records the file version required by edit/write.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to read (absolute or relative to the session working directory)." },
          offset: { type: "integer", description: "Line number to start reading from (1-indexed; defaults to 1). Applies only to text files; ignored for images." },
          limit: { type: "integer", description: "Maximum number of lines to read (defaults to 2000). Applies only to text files; ignored for images. Output may be truncated by the tool's output limit; use the returned offset to continue." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const signal = context.signal ?? context.handle.signal;
        const plainText = context.exposureState?.scope === "codemode";
        const target = paths.resolveReadable(context.workspace, input.path);
        const path = target.path;
        let info: BigIntStats;
        try {
          info = await stat(path, { bigint: true });
        } catch (cause) {
          if (!isMissingPathError(cause)) throw cause;
          throw new Error(`file not found: ${input.path}`);
        }
        if (!info.isFile()) throw new Error(`file not found: ${input.path}`);
        const version = fileVersionFromStats(info);
        const head = await readHeadBytes(path, 4_100, signal);
        if (detectReadImageMime(head)) {
          const data = await readFile(path, { signal });
          await assertFileVersionUnchanged(path, version);
          const prepared = await imageProcessor.process(data, "read");
          assertActive(signal);
          ledger.recordVersion(context.session_id, path, version);
          const scale = prepared.processed.width > 0 ? prepared.original.width / prepared.processed.width : 1;
          return {
            image_view: { path, name: basename(path), media_type: prepared.mediaType },
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
        const count = Math.max(1, Number(input.limit ?? DEFAULT_READ_LINES));
        const charBudget = Math.max(1, toolOutputLimit - READ_HINT_CHAR_RESERVE);
        const range = await readTextRange(
          path,
          start,
          count,
          charBudget,
          plainText,
          signal,
        );
        await assertFileVersionUnchanged(path, version);
        assertActive(signal);
        ledger.recordVersion(context.session_id, path, version);
        const hint = range.truncatedLine === undefined
          ? range.hasMore && range.nextOffset !== undefined
            ? `... (更多内容，使用 offset=${range.nextOffset} 继续)`
            : ""
          : `... (第 ${range.truncatedLine} 行超过本次 ${charBudget} 字符正文预算${plainText ? "" : "（含行号）"}；请使用 exec 的字节工具读取该超长行)`;
        await context.exposureState?.activateSkillPath(path);
        if (!hint) return { content: textBlock(range.body) };
        const separator = range.body ? "\n" : "";
        const bodyLimit = Math.max(0, toolOutputLimit - separator.length - hint.length);
        return { content: textBlock(`${range.body.slice(0, bodyLimit)}${separator}${hint}`) };
      },
    },
    {
      name: "write",
      codemodeResult: "text",
      description: "Create or overwrite a UTF-8 file. Relative paths resolve from the session working directory." + permissionToolDescription,
      input_schema: { type: "object", properties: { ...permissionInputProperties, file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"], additionalProperties: false },
      execute: async (input, context) => {
        input = structuredClone(input);
        if (typeof input.content !== "string") throw new ToolExecutionError("invalid_argument", "write requires string content");
        const signal = context.signal ?? context.handle.signal;
        const policy = requestedPolicy(input, context.executionPolicy);
        assertActive(signal);
        const requested = paths.resolveWritable(context.workspace, input.file_path);
        const target = inspectFileWriteTarget(policy, requested, true, executionPaths);
        const { path } = target;
        const version = writeTargetVersion(target);
        if (version !== undefined) ledger.assertVersion(context.session_id, requested, "write", version);
        const content = input.content;
        if (policy.mode !== context.executionPolicy.mode) {
          const identity = canonicalPathCandidate(requested);
          await approveIfNeeded(dependencies.approvals, "write", input, context, policy, { path: requested, content });
          if (canonicalPathCandidate(requested) !== identity) throw new Error(`write target changed during approval; read it again: ${requested}`);
          const after = recheckFileWriteTarget(policy, requested, target, executionPaths);
          if (writeTargetVersion(after) !== version) throw new Error(`write target changed during approval; read it again: ${requested}`);
        }
        assertActive(signal);
        mkdirSync(dirname(path), { recursive: true });
        const current = recheckFileWriteTarget(policy, requested, target, executionPaths);
        const currentVersion = writeTargetVersion(current);
        if (version !== currentVersion) {
          throw new Error(`write 被拒绝：文件在写入前发生变化，请重新 read 确认最新内容: ${path}`);
        }
        if (version !== undefined) ledger.assertVersion(context.session_id, requested, "write", currentVersion);
        assertActive(signal);
        writeFileSync(path, content, "utf8");
        ledger.recordCurrent(context.session_id, requested, path);
        return { content: textBlock(`Wrote ${relative(context.workspace.directory, requested)}`) };
      },
    },
    {
      name: "edit",
      codemodeResult: "text",
      description: "Edit an existing UTF-8 file using edits[{oldText,newText}]. Read the file first; changes since the last read/write are rejected. Combine disjoint changes in one call: every oldText must uniquely match the same ORIGINAL file, and targets must not overlap. Exact matching is preferred, with normalized whitespace/Unicode matching as fallback. All edits are checked before writing. Returns a bounded diff summary. Relative paths resolve from the session working directory." + permissionToolDescription,
      input_schema: editInputSchema,
      execute: async (input, context) => {
        const signal = context.signal ?? context.handle.signal;
        input = structuredClone(input);
        const policy = requestedPolicy(input, context.executionPolicy);
        assertActive(signal);
        const args = validateEditInput(input);
        const requested = paths.resolveWritable(context.workspace, args.path);
        const target = inspectFileWriteTarget(policy, requested, false, executionPaths);
        const { path } = target;
        const version = writeTargetVersion(target);
        ledger.assertVersion(context.session_id, requested, "edit", version);
        const source = readFileSync(path, "utf8");
        const prepared = prepareTextEdit(source, args.edits);
        const summary = summarizeTextEdit(relative(context.workspace.directory, requested), args.edits.length, prepared, toolOutputLimit);
        if (policy.mode !== context.executionPolicy.mode) {
          const identity = canonicalPathCandidate(requested);
          await approveIfNeeded(dependencies.approvals, "edit", input, context, policy, { path: requested, edits: args.edits.map(edit => ({ ...edit })) });
          if (canonicalPathCandidate(requested) !== identity) throw new Error(`edit target changed during approval; read it again: ${requested}`);
        }
        const current = recheckFileWriteTarget(policy, requested, target, executionPaths);
        if (writeTargetVersion(current) !== version) throw new Error(`edit 被拒绝：文件发生变化，请重新 read: ${path}`);
        ledger.assertVersion(context.session_id, requested, "edit", writeTargetVersion(current));
        assertActive(signal);
        writeFileSync(path, prepared.content, "utf8");
        ledger.recordCurrent(context.session_id, requested, path);
        return { content: textBlock(summary) };
      },
    },
  ];
  return tools.map(tool => tool.name === "read" ? tool : { ...tool, execute: async (input, context) => {
    try { return await tool.execute(input, context); }
    catch (error) {
      if (error instanceof ToolExecutionError && error.details?.type === "file_permission_denied") {
        const hint = dependencies.approvals && context.platform === "desktop"
          ? " If this operation is necessary, explicitly request the smallest sufficient wider sandbox_permissions with justification for a single approval."
          : " Single-operation approval is unavailable on this channel.";
        throw new ToolExecutionError(error.code, error.message + hint, error.details);
      }
      throw error;
    }
  } });
}
