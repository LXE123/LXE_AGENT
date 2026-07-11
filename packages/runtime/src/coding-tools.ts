import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "@lxe/protocol";
import type { RuntimeHandle } from "./types";
import { ToolRegistry } from "./tools";

export interface CodingToolOptions {
  workspaceRoot: string;
  maxOutputChars?: number;
  sendFile?: (request: { path: string; session_id: string; response_route_id: string }) => Promise<void>;
  onProcessComplete?: (snapshot: JsonObject) => Promise<void> | void;
}

type ProcessStatus = "running" | "completed" | "failed" | "timeout" | "killed";

interface ProcessEntry {
  id: string;
  command: string;
  cwd: string;
  sessionId: string;
  responseRouteId: string;
  startedAt: number;
  endedAt?: number;
  process: ReturnType<typeof Bun.spawn>;
  status: ProcessStatus;
  exitCode: number | null;
  output: string;
  pending: string;
  tail: string;
  truncated: boolean;
  completion: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  notifyOnExit: boolean;
}

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const jsonResult = (payload: JsonObject) => ({ content: textBlock(JSON.stringify(payload, null, 2)) });
const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

const PROTECTED_ROOT_FILES = new Set([
  ".env", ".env.local", ".envrc", ".env.development", ".env.production", ".env.test", ".env.staging",
]);
const PROTECTED_ROOT_DIRECTORIES = new Set(["user_session_db"]);
const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
]);
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const BINARY_EXTENSIONS = new Set([
  ".pyc", ".pyo", ".exe", ".dll", ".so", ".bin", ".zip", ".tar", ".gz", ".7z", ".rar", ".whl",
  ".pdf", ".xlsx", ".xlsm", ".xltx", ".xltm", ".xls", ".docx", ".docm", ".dotx", ".dotm",
  ".doc", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppt", ".odt", ".ods", ".odp",
]);

const containsPath = (root: string, path: string): boolean => {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
};

const canonicalCandidate = (path: string): string => {
  if (existsSync(path)) return realpathSync(path);
  const missing: string[] = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : resolve(cursor);
  return resolve(base, ...missing);
};

const safePath = (root: string, value: unknown): string => {
  const requested = String(value ?? ".").trim() || ".";
  const path = resolve(root, requested);
  if (!containsPath(root, path) || !containsPath(realpathSync(root), canonicalCandidate(path))) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  return path;
};

const readablePath = (root: string, value: unknown): string => {
  const requested = String(value ?? "").trim();
  if (!requested) throw new Error("path is required");
  const path = resolve(root, requested);
  const externalRoot = resolve(homedir(), ".agents", "skills");
  const canonical = canonicalCandidate(path);
  if (containsPath(realpathSync(root), canonical)) return path;
  if (existsSync(externalRoot) && containsPath(realpathSync(externalRoot), canonical)) return path;
  throw new Error(`path escapes workspace and external skills: ${requested}`);
};

const assertWritable = (root: string, path: string): void => {
  const rel = relative(root, path);
  const parts = rel.split(/[\\/]+/u);
  if (parts.length === 1 && PROTECTED_ROOT_FILES.has(parts[0]!.toLowerCase())) {
    throw new Error(`write denied for protected workspace file: ${rel}`);
  }
  if (parts[0] && PROTECTED_ROOT_DIRECTORIES.has(parts[0].toLowerCase())) {
    throw new Error(`write denied for protected workspace directory: ${parts[0]}/`);
  }
};

const walk = (root: string, current = root): string[] => {
  const results: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) results.push(...walk(root, path));
    else if (entry.isFile()) results.push(relative(root, path));
  }
  return results;
};

const globRegex = (pattern: string): RegExp => new RegExp(`^${pattern
  .replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
  .replaceAll("**", "\0")
  .replaceAll("*", "[^/\\\\]*")
  .replaceAll("\0", ".*")
  .replaceAll("?", ".")}$`, "i");

const truncateHeadTail = (value: string, limit: number): { value: string; truncated: boolean } => {
  if (value.length <= limit) return { value, truncated: false };
  const marker = `\n... (truncated, ${value.length} chars total) ...\n`;
  const available = Math.max(2, limit - marker.length);
  const head = Math.floor(available / 2);
  return { value: `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`, truncated: true };
};

const fileMtime = (path: string): bigint | undefined => {
  try { return statSync(path, { bigint: true }).mtimeNs; } catch { return undefined; }
};

class FileReadLedger {
  private readonly entries = new Map<string, bigint>();
  private readonly maximum = 10_000;

  record(sessionId: string, path: string): void {
    const mtime = fileMtime(path);
    if (mtime === undefined) return;
    const key = `${sessionId}\0${path}`;
    this.entries.delete(key);
    this.entries.set(key, mtime);
    while (this.entries.size > this.maximum) this.entries.delete(this.entries.keys().next().value!);
  }

  assertCurrent(sessionId: string, path: string, action: string): void {
    const key = `${sessionId}\0${path}`;
    const recorded = this.entries.get(key);
    if (recorded === undefined) throw new Error(`${action} 被拒绝：请先用 read 读取该文件再修改: ${path}`);
    const current = fileMtime(path);
    if (current !== undefined && current !== recorded) {
      throw new Error(`${action} 被拒绝：文件在上次 read 之后被修改过，请重新 read 确认最新内容: ${path}`);
    }
  }
}

const terminateTree = async (entry: ProcessEntry): Promise<void> => {
  if (process.platform === "win32") {
    const taskkill = Bun.which("taskkill");
    if (taskkill) {
      const killer = Bun.spawn([taskkill, "/PID", String(entry.process.pid), "/T", "/F"], {
        stdout: "ignore", stderr: "ignore", windowsHide: true,
      });
      await killer.exited;
      return;
    }
  }
  entry.process.kill("SIGKILL");
};

const powershell = (): string => {
  const executable = Bun.which("pwsh") ?? Bun.which("powershell");
  if (!executable) throw new Error("PowerShell is unavailable");
  return executable;
};

const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const normalizeProjectPythonCommand = (root: string, command: string): string => {
  if (/\b(?:services\.agent_cli|browser_auth_service\.main)\b/iu.test(command)) {
    throw new Error("registered business Python modules must be called through the JSON script bridge");
  }
  const python = process.platform === "win32"
    ? join(root, ".venv", "Scripts", "python.exe")
    : join(root, ".venv", "bin", "python");
  const pip = process.platform === "win32"
    ? join(root, ".venv", "Scripts", "pip.exe")
    : join(root, ".venv", "bin", "pip");
  const leading = command.match(/^\s*(python3?|py)(?=\s|$)/iu);
  if (leading) {
    if (!existsSync(python)) throw new Error(`project Python is unavailable: ${python}`);
    return command.replace(leading[0], `${leading[0].match(/^\s*/u)?.[0] ?? ""}${quotePowerShell(python)}`);
  }
  const leadingPip = command.match(/^\s*pip3?(?=\s|$)/iu);
  if (leadingPip) {
    if (!existsSync(pip)) throw new Error(`project pip is unavailable: ${pip}`);
    return command.replace(leadingPip[0], `${leadingPip[0].match(/^\s*/u)?.[0] ?? ""}${quotePowerShell(pip)}`);
  }
  return command;
};

export class CodingProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();

  constructor(private readonly options: {
    maxOutputChars: number;
    maxPendingChars: number;
    tailChars: number;
    ttlSeconds: number;
  }) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].filter((entry) => entry.status === "running").map((entry) => terminateTree(entry)));
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.completion));
  }

  snapshots(): JsonObject[] {
    this.sweep();
    return [...this.entries.values()].sort((left, right) => right.startedAt - left.startedAt).map((entry) => this.snapshot(entry));
  }

  async execute(request: {
    command: string;
    cwd: string;
    sessionId: string;
    responseRouteId: string;
    background: boolean;
    yieldMs: number;
    timeoutMs?: number;
    handle: RuntimeHandle;
    turnId?: string;
  }): Promise<JsonObject> {
    this.sweep();
    const id = `exec_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const child = Bun.spawn([
      powershell(), "-NoProfile", "-NonInteractive", "-Command",
      "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; " + request.command,
    ], {
      cwd: request.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        LXE_AGENT_SESSION_ID: request.sessionId,
        LXE_RESPONSE_ROUTE_ID: request.responseRouteId,
        LXE_AGENT_TURN_ID: request.turnId ?? "",
        LXE_EXEC_SESSION_ID: id,
      },
    });
    const entry: ProcessEntry = {
      id,
      command: request.command,
      cwd: request.cwd,
      sessionId: request.sessionId,
      responseRouteId: request.responseRouteId,
      startedAt: Date.now() / 1_000,
      process: child,
      status: "running" as ProcessStatus,
      exitCode: null,
      output: "",
      pending: "",
      tail: "",
      truncated: false,
      completion: Promise.resolve(),
      notifyOnExit: request.background,
    };
    this.entries.set(id, entry);
    const append = (value: string): void => {
      const pending = truncateHeadTail(entry.pending + value, this.options.maxPendingChars);
      entry.pending = pending.value;
      const output = truncateHeadTail(entry.output + value, this.options.maxOutputChars);
      entry.output = output.value;
      entry.tail = (entry.tail + value).slice(-this.options.tailChars);
      entry.truncated ||= pending.truncated || output.truncated;
    };
    const pump = async (stream: ReadableStream<Uint8Array>, stderr: boolean): Promise<void> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        append(`${stderr ? "[stderr] " : ""}${decoder.decode(chunk.value, { stream: true })}`);
      }
      const tail = decoder.decode();
      if (tail) append(`${stderr ? "[stderr] " : ""}${tail}`);
    };
    const stdoutTask = pump(child.stdout, false);
    const stderrTask = pump(child.stderr, true);
    entry.completion = (async () => {
      const exitCode = await child.exited;
      await Promise.allSettled([stdoutTask, stderrTask]);
      entry.exitCode = exitCode;
      entry.endedAt = Date.now() / 1_000;
      if (entry.status === "running") entry.status = exitCode === 0 ? "completed" : "failed";
      if (entry.timeout) clearTimeout(entry.timeout);
      if (entry.notifyOnExit) await this.onComplete?.(this.snapshot(entry));
    })();
    if (!request.background && request.timeoutMs) {
      entry.timeout = setTimeout(() => {
        if (entry.status !== "running") return;
        entry.status = "timeout";
        void terminateTree(entry);
      }, request.timeoutMs);
    }
    if (request.background) return this.snapshot(entry);

    const unregister = request.handle.registerProcess({
      kill: () => terminateTree(entry),
      forceKill: () => terminateTree(entry),
    });
    const abort = (): void => { entry.status = "killed"; void terminateTree(entry); };
    request.handle.signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([entry.completion, Bun.sleep(request.yieldMs)]);
      if (entry.status === "running") entry.notifyOnExit = true;
      return this.snapshot(entry);
    } finally {
      request.handle.signal.removeEventListener("abort", abort);
      unregister();
    }
  }

  async process(input: JsonObject): Promise<JsonObject> {
    const action = inputText(input, "action").trim();
    if (action === "list") return { items: this.snapshots(), total: this.entries.size };
    const id = inputText(input, "session").trim();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`exec session not found: ${id}`);
    if (action === "poll") {
      if (entry.status === "running" && !entry.pending) {
        await Promise.race([entry.completion, Bun.sleep(5_000)]);
      }
      const output = entry.pending;
      entry.pending = "";
      return { ...this.snapshot(entry), output };
    }
    if (action === "log") {
      const lines = entry.output.split(/\r?\n/);
      const offset = Math.max(1, Number(input.offset ?? 1));
      const limit = Math.max(1, Math.min(Number(input.limit ?? 2_000), 10_000));
      return { ...this.snapshot(entry), output: lines.slice(offset - 1, offset - 1 + limit).join("\n"), offset, limit };
    }
    if (action === "write") {
      if (entry.status !== "running") throw new Error(`exec session is not running: ${id}`);
      const stdin = entry.process.stdin;
      if (!stdin || typeof stdin === "number") throw new Error(`exec session stdin is unavailable: ${id}`);
      stdin.write(`${inputText(input, "text")}\n`);
      return this.snapshot(entry);
    }
    if (action === "kill" || action === "remove") {
      if (entry.status === "running") {
        entry.status = "killed";
        await terminateTree(entry);
        await entry.completion;
      }
      const payload = this.snapshot(entry);
      if (action === "remove") this.entries.delete(id);
      return payload;
    }
    throw new Error(`unsupported process action: ${action}`);
  }

  private snapshot(entry: ProcessEntry): JsonObject {
    const endedAt = entry.endedAt ?? null;
    return {
      task_id: entry.id,
      session: entry.id,
      session_id: entry.sessionId,
      response_route_id: entry.responseRouteId,
      session_title: "",
      origin_turn_id: "",
      card_id: "",
      status: entry.status,
      pid: entry.process.pid,
      command: entry.command,
      cwd: entry.cwd,
      started_at: entry.startedAt,
      ended_at: endedAt,
      duration_sec: (endedAt ?? Date.now() / 1_000) - entry.startedAt,
      background: entry.status === "running",
      exit_code: entry.exitCode,
      truncated: entry.truncated,
      output_tail: entry.tail,
    };
  }

  private sweep(): void {
    const cutoff = Date.now() / 1_000 - this.options.ttlSeconds;
    for (const [id, entry] of this.entries) {
      if (entry.status !== "running" && (entry.endedAt ?? Number.POSITIVE_INFINITY) < cutoff) this.entries.delete(id);
    }
  }

  onComplete: ((snapshot: JsonObject) => Promise<void> | void) | undefined;
}

export function registerCodingTools(registry: ToolRegistry, options: CodingToolOptions): CodingProcessManager {
  const root = resolve(options.workspaceRoot);
  const toolOutputLimit = 10_000;
  const processOutputLimit = Math.max(1_000, Math.trunc(options.maxOutputChars ?? 200_000));
  const ledger = new FileReadLedger();
  const processes = new CodingProcessManager({
    maxOutputChars: processOutputLimit,
    maxPendingChars: 30_000,
    tailChars: 2_000,
    ttlSeconds: 1_800,
  });
  processes.onComplete = options.onProcessComplete;
  registry.register({
    name: "read",
    description: "Read a text or image file from the workspace, or a read-only file under ~/.agents/skills. Reading records the file version required by edit/write.",
    input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false },
    execute: async (input, context) => {
      const path = readablePath(root, input.path);
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`file not found: ${input.path}`);
      const extension = extname(path).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES[extension];
      if (mediaType) {
        const data = readFileSync(path);
        ledger.record(context.session_id, path);
        return {
          content: [
            { type: "text", text: `MEDIA:${path}` },
            { type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } },
          ],
        };
      }
      if (BINARY_EXTENSIONS.has(extension)) throw new Error(`binary file cannot be read as text: ${input.path}`);
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      const start = Math.max(1, Number(input.offset ?? 1));
      const count = Math.max(1, Number(input.limit ?? lines.length));
      ledger.record(context.session_id, path);
      const body = lines.slice(start - 1, start - 1 + count)
        .map((line, index) => `${String(start + index).padStart(6, " ")}\t${line}`).join("\n");
      return { content: textBlock(truncateHeadTail(body, toolOutputLimit).value) };
    },
  });
  registry.register({
    name: "write",
    description: "Create or overwrite a UTF-8 file inside the workspace.",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"], additionalProperties: false },
    execute: async (input, context) => {
      const path = safePath(root, input.file_path);
      assertWritable(root, path);
      if (existsSync(path)) {
        if (!statSync(path).isFile()) throw new Error(`path is not a regular file: ${input.file_path}`);
        ledger.assertCurrent(context.session_id, path, "write");
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, inputText(input, "content"), "utf8");
      ledger.record(context.session_id, path);
      return { content: textBlock(`Wrote ${relative(root, path)}`) };
    },
  });
  registry.register({
    name: "edit",
    description: "Replace exact text in a workspace file.",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"], additionalProperties: false },
    execute: async (input, context) => {
      const path = safePath(root, input.file_path);
      assertWritable(root, path);
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
      ledger.record(context.session_id, path);
      return { content: textBlock(`Edited ${relative(root, path)}`) };
    },
  });
  registry.register({
    name: "grep",
    description: "Search UTF-8 workspace files for a regular expression.",
    input_schema: { type: "object", properties: {
      pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, type: { type: "string" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      case_insensitive: { type: "boolean" }, context: { type: "integer" }, before_context: { type: "integer" },
      after_context: { type: "integer" }, multiline: { type: "boolean" }, head_limit: { type: "integer" },
    }, required: ["pattern"], additionalProperties: false },
    execute: async (input) => {
      const base = safePath(root, input.path ?? ".");
      const pattern = inputText(input, "pattern");
      if (!pattern) throw new Error("pattern 不能为空");
      const flags = `${input.case_insensitive ? "i" : ""}${input.multiline ? "s" : ""}u`;
      const regex = new RegExp(pattern, flags);
      const files = statSync(base).isFile() ? [relative(root, base)] : walk(root, base);
      const matches: string[] = [];
      const maxLines = Math.max(1, Number(input.head_limit ?? 100));
      const mode = String(input.output_mode ?? "files_with_matches");
      const glob = inputText(input, "glob");
      const globMatcher = glob ? globRegex(glob.replace(/^!/u, "")) : undefined;
      const excludedGlob = glob.startsWith("!");
      const typeExtensions: Record<string, string[]> = { py: [".py"], ts: [".ts", ".tsx"], js: [".js", ".jsx"], json: [".json"], md: [".md"] };
      const requestedType = inputText(input, "type");
      if (requestedType && !typeExtensions[requestedType]) throw new Error(`未知 type: ${requestedType}`);
      for (const file of files) {
        const normalized = file.replaceAll("\\", "/");
        if (globMatcher && globMatcher.test(normalized) === excludedGlob) continue;
        if (requestedType && !typeExtensions[requestedType]!.includes(extname(file).toLowerCase())) continue;
        const absolute = safePath(root, file);
        let source: string;
        try { source = readFileSync(absolute, "utf8"); } catch { continue; }
        const lines = source.split(/\r?\n/);
        const matchingLines: number[] = [];
        if (input.multiline) {
          for (const match of source.matchAll(new RegExp(pattern, `${flags.includes("i") ? "i" : ""}gsu`))) {
            matchingLines.push(source.slice(0, match.index).split(/\r?\n/).length - 1);
          }
        } else lines.forEach((line, index) => { regex.lastIndex = 0; if (regex.test(line)) matchingLines.push(index); });
        if (matchingLines.length === 0) continue;
        if (mode === "files_with_matches") matches.push(file);
        else if (mode === "count") matches.push(`${file}:${matchingLines.length}`);
        else {
          const common = Math.max(0, Number(input.context ?? 0));
          const before = Math.max(0, Number(input.before_context ?? common));
          const after = Math.max(0, Number(input.after_context ?? common));
          const emitted = new Set<number>();
          for (const lineIndex of matchingLines) {
            for (let current = Math.max(0, lineIndex - before); current <= Math.min(lines.length - 1, lineIndex + after); current += 1) {
              if (emitted.has(current)) continue;
              emitted.add(current);
              matches.push(`${file}${current === lineIndex ? ":" : "-"}${current + 1}${current === lineIndex ? ":" : "-"}${lines[current]}`);
            }
          }
        }
        if (matches.length >= maxLines) break;
      }
      const output = matches.length === 0 ? "No matches found." : matches.slice(0, maxLines).join("\n");
      return { content: textBlock(truncateHeadTail(output, toolOutputLimit).value) };
    },
  });
  registry.register({
    name: "find",
    description: "Find workspace files by glob-like pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, head_limit: { type: "integer" } }, required: ["pattern"], additionalProperties: false },
    execute: async (input) => {
      const base = safePath(root, input.path ?? ".");
      const regex = globRegex(inputText(input, "pattern"));
      const max = Math.max(1, Number(input.head_limit ?? 200));
      const files = walk(base).filter((path) => regex.test(path.replaceAll("\\", "/")) || regex.test(basename(path)))
        .map((path) => ({ path, mtime: statSync(join(base, path)).mtimeMs }))
        .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
      const selected = files.slice(0, max).map((item) => item.path);
      if (files.length > max) selected.push(`... showing first ${max} of ${files.length}`);
      return { content: textBlock(truncateHeadTail(selected.join("\n"), toolOutputLimit).value) };
    },
  });
  registry.register({
    name: "ls",
    description: "List workspace directory contents.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    execute: async (input) => {
      const base = safePath(root, input.path ?? ".");
      const entries = readdirSync(base, { withFileTypes: true }).map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`).sort();
      return { content: textBlock(truncateHeadTail(entries.join("\n"), toolOutputLimit).value) };
    },
  });
  registry.register({
    name: "send_file",
    description: "Send an existing workspace artifact to the current user.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async (input, context) => {
      const path = safePath(root, input.path);
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`file not found: ${input.path}`);
      const artifacts = join(root, "artifacts");
      const rel = relative(root, path).replaceAll("\\", "/");
      const skillAsset = /^skills\/[^/]+\/assets\//u.test(rel);
      if (!containsPath(artifacts, path) && !skillAsset) throw new Error("send_file only allows artifacts/** or skills/*/assets/**");
      if (options.sendFile) await options.sendFile({ path, session_id: context.session_id, response_route_id: context.response_route_id ?? "" });
      return { content: textBlock(`Sent ${relative(root, path)}`), files: [path] };
    },
  });
  registry.register({
    name: "exec",
    description: "Execute a PowerShell command; long-running commands become process sessions.",
    input_schema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number" }, background: { type: "boolean" }, yield_ms: { type: "number" } }, required: ["command"], additionalProperties: false },
    execute: async (input, context) => {
      const command = normalizeProjectPythonCommand(root, inputText(input, "command").trim());
      if (!command) throw new Error("command 不能为空");
      const payload = await processes.execute({
        command,
        cwd: safePath(root, input.cwd ?? "."),
        sessionId: context.session_id,
        responseRouteId: context.response_route_id ?? "",
        background: input.background === true,
        yieldMs: Math.max(1, Number(input.yield_ms ?? 10_000)),
        ...(input.timeout === undefined ? { timeoutMs: 120_000 } : { timeoutMs: Math.max(1, Number(input.timeout) * 1_000) }),
        handle: context.handle,
        ...(context.turn_id === undefined ? {} : { turnId: context.turn_id }),
      });
      if (payload.status === "failed" || payload.status === "timeout") throw new Error(`command ${payload.status}: ${payload.output_tail ?? ""}`);
      return jsonResult(payload);
    },
  });
  registry.register({
    name: "process",
    description: "Manage exec sessions: list, poll, log, write, kill, or remove.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["list", "poll", "log", "write", "kill", "remove"] }, session: { type: "string" }, text: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["action"], additionalProperties: false },
    execute: async (input) => jsonResult(await processes.process(input)),
  });
  return processes;
}
