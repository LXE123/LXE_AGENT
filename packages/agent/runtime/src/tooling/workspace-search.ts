import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

export const MANAGED_RIPGREP_VERSION = "15.1.0";
const RIPGREP_TIMEOUT_MS = 30_000;
// Safety ceiling for retained rg output even if head_limit is huge or a
// pathological search matches a multi-megabyte data file in the workspace.
const RIPGREP_OUTPUT_BYTE_BUDGET = 1_024 * 1_024;
const RIPGREP_STDERR_BYTE_BUDGET = 64 * 1_024;
// Bound single-line width so one minified/data line cannot exhaust the budget.
const RIPGREP_MAX_COLUMNS = 500;
const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
]);
const TYPE_EXTENSIONS: Record<string, string[]> = {
  py: [".py", ".pyi"],
  js: [".js", ".mjs", ".cjs", ".jsx"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  json: [".json"],
  yaml: [".yml", ".yaml"],
  toml: [".toml"],
  md: [".md", ".markdown"],
  html: [".html", ".htm"],
  css: [".css", ".scss", ".sass"],
  sh: [".sh", ".bash", ".zsh"],
  ps: [".ps1", ".psm1", ".psd1"],
  sql: [".sql"],
  csv: [".csv"],
  txt: [".txt"],
};

export type GrepOutputMode = "files_with_matches" | "content" | "count";

export interface WorkspaceGrepRequest {
  pattern: string;
  searchPath: string;
  outputMode: GrepOutputMode;
  glob?: string;
  fileType?: string;
  caseInsensitive?: boolean;
  context?: number;
  beforeContext?: number;
  afterContext?: number;
  multiline?: boolean;
  limit: number;
  signal?: AbortSignal;
}

export interface WorkspaceFindRequest {
  pattern: string;
  searchPath: string;
  limit: number;
  signal?: AbortSignal;
}

export interface WorkspaceSearchOptions {
  ripgrepPath?: string | null;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  which?: (name: string) => string | null;
  absolutePaths?: boolean;
}

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

export function managedRipgrepPath(
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return undefined;
  return join(homeDirectory, ".lxe", "tools", "ripgrep", MANAGED_RIPGREP_VERSION, "win32-x64", "rg.exe");
}

export function resolveRipgrepExecutable(options: WorkspaceSearchOptions = {}): string | undefined {
  if (options.ripgrepPath !== undefined) return options.ripgrepPath || undefined;
  const managed = managedRipgrepPath(options.homeDirectory, options.platform);
  if (managed && existsSync(managed)) return managed;
  return (options.which ?? Bun.which)("rg") ?? undefined;
}

export function isProbablyBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4_096);
  if (sample.byteLength === 0) return false;
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const value of sample) {
    if (value < 32 && value !== 9 && value !== 10 && value !== 13) controls += 1;
  }
  return controls > Math.max(4, Math.floor(sample.byteLength / 20));
}

const globRegex = (pattern: string): RegExp => new RegExp(`^${pattern
  .replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
  .replaceAll("**", "\0")
  .replaceAll("*", "[^/\\\\]*")
  .replaceAll("\0", ".*")
  .replaceAll("?", ".")}$`, "i");

const abortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ?? new DOMException("Aborted", "AbortError");

const assertActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortReason(signal);
};

const collectFiles = async (workspaceRoot: string, searchPath: string, signal?: AbortSignal): Promise<string[]> => {
  assertActive(signal);
  const info = await stat(searchPath);
  if (info.isFile()) return [normalizePath(relative(workspaceRoot, searchPath))];
  if (!info.isDirectory()) return [];
  const results: string[] = [];
  let visited = 0;
  const visit = async (directory: string): Promise<void> => {
    assertActive(signal);
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertActive(signal);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        results.push(normalizePath(relative(workspaceRoot, join(directory, entry.name))));
      }
      visited += 1;
      if (visited % 64 === 0) await Bun.sleep(0);
    }
  };
  await visit(searchPath);
  return results;
};

const matchesGlob = (workspaceRelativePath: string, searchRelativePath: string, glob: string): boolean => {
  if (!glob) return true;
  const excluded = glob.startsWith("!");
  const matcher = globRegex(excluded ? glob.slice(1) : glob);
  const matched = matcher.test(searchRelativePath) || matcher.test(basename(workspaceRelativePath));
  return excluded ? !matched : matched;
};

const limitLines = (lines: string[], limit: number): string[] => {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `... (${lines.length - limit} more lines, raise head_limit or narrow the search)`];
};

type RipgrepStopReason = "" | "limit" | "budget";

interface RipgrepResult {
  exitCode: number;
  lines: string[];
  stderr: string;
  stopReason: RipgrepStopReason;
}

const readCappedText = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - keptBytes;
      if (room > 0) {
        const kept = value.byteLength > room ? value.subarray(0, room) : value;
        chunks.push(kept);
        keptBytes += kept.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

// Streams rg stdout line by line and stops the process as soon as `limit`
// output lines are collected or the UTF-8 byte ceiling is hit, so a large match
// set is never fully buffered. Ordering follows rg's parallel file walk, which
// was already nondeterministic under the previous "buffer then slice" logic.
const runRipgrep = async (
  executable: string,
  args: string[],
  cwd: string,
  limit: number,
  signal?: AbortSignal,
): Promise<RipgrepResult> => {
  assertActive(signal);
  const child = Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
  let timedOut = false;
  const stop = (): void => { try { child.kill(); } catch { /* already exited */ } };
  const onAbort = (): void => stop();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; stop(); }, RIPGREP_TIMEOUT_MS);
  timeout.unref?.();
  const stderrPromise = readCappedText(child.stderr as ReadableStream<Uint8Array>, RIPGREP_STDERR_BYTE_BUDGET);
  const lines: string[] = [];
  let stopReason: RipgrepStopReason = "";
  try {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let keptBytes = 0;
    try {
      reading: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let index = pending.indexOf("\n");
        while (index !== -1) {
          const line = pending.slice(0, index).replace(/\r$/u, "");
          pending = pending.slice(index + 1);
          if (lines.length >= limit) { stopReason = "limit"; break reading; }
          const lineBytes = Buffer.byteLength(line, "utf8") + 1;
          if (keptBytes + lineBytes > RIPGREP_OUTPUT_BYTE_BUDGET) {
            stopReason = "budget";
            break reading;
          }
          lines.push(line);
          keptBytes += lineBytes;
          index = pending.indexOf("\n");
        }
        // Backstop: a chunk with no newline grows `pending`, so cap it too.
        if (Buffer.byteLength(pending, "utf8") >= RIPGREP_OUTPUT_BYTE_BUDGET) {
          stopReason = stopReason || "budget";
          break;
        }
      }
      if (!stopReason) {
        const tail = (pending + decoder.decode()).replace(/\r$/u, "");
        if (tail.trim()) {
          if (lines.length >= limit) stopReason = "limit";
          else {
            const tailBytes = Buffer.byteLength(tail, "utf8");
            if (keptBytes + tailBytes > RIPGREP_OUTPUT_BYTE_BUDGET) stopReason = "budget";
            else lines.push(tail);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (stopReason) stop();
    const exitCode = await child.exited;
    const stderr = await stderrPromise;
    if (signal?.aborted) throw abortReason(signal);
    if (timedOut) throw new Error(`grep 超时（${RIPGREP_TIMEOUT_MS / 1_000}s），请缩小搜索范围`);
    return { exitCode, lines, stderr, stopReason };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
};

const matchingLineIndexes = (source: string, pattern: string, caseInsensitive: boolean, multiline: boolean): number[] => {
  if (multiline) {
    const regex = new RegExp(pattern, `${caseInsensitive ? "i" : ""}gsu`);
    return [...source.matchAll(regex)].map((match) => source.slice(0, match.index).split(/\r?\n/u).length - 1);
  }
  const regex = new RegExp(pattern, `${caseInsensitive ? "i" : ""}u`);
  const indexes: number[] = [];
  source.split(/\r?\n/u).forEach((line, index) => {
    regex.lastIndex = 0;
    if (regex.test(line)) indexes.push(index);
  });
  return indexes;
};

export class WorkspaceSearchService {
  private readonly ripgrepPath: string | undefined;
  private readonly absolutePaths: boolean;

  constructor(private readonly workspaceRoot: string, options: WorkspaceSearchOptions = {}) {
    this.ripgrepPath = resolveRipgrepExecutable(options);
    this.absolutePaths = options.absolutePaths ?? false;
  }

  private displayPath(path: string): string {
    return this.absolutePaths ? normalizePath(resolve(this.workspaceRoot, path)) : path;
  }

  async grep(request: WorkspaceGrepRequest): Promise<string> {
    if (this.ripgrepPath) return this.grepWithRipgrep(request, this.ripgrepPath);
    return this.grepFallback(request);
  }

  async find(request: WorkspaceFindRequest): Promise<string> {
    const files = await collectFiles(this.workspaceRoot, request.searchPath, request.signal);
    const baseRelative = normalizePath(relative(this.workspaceRoot, request.searchPath));
    const matcher = globRegex(request.pattern);
    const matched: Array<{ path: string; mtime: number }> = [];
    for (let index = 0; index < files.length; index += 16) {
      assertActive(request.signal);
      const batch = files.slice(index, index + 16);
      const details = await Promise.all(batch.map(async (path) => {
        const searchRelative = baseRelative && path.startsWith(`${baseRelative}/`) ? path.slice(baseRelative.length + 1) : path;
        if (!matcher.test(searchRelative) && !matcher.test(basename(path))) return undefined;
        try {
          return { path, mtime: (await stat(join(this.workspaceRoot, path))).mtimeMs };
        } catch {
          return { path, mtime: 0 };
        }
      }));
      matched.push(...details.filter((item): item is { path: string; mtime: number } => Boolean(item)));
      await Bun.sleep(0);
    }
    matched.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
    if (matched.length === 0) return "No files found.";
    const lines = matched.slice(0, request.limit).map((item) => this.displayPath(item.path));
    if (matched.length > request.limit) {
      lines.push(`... (showing first ${request.limit} of ${matched.length} results, sorted by modification time)`);
    }
    return lines.join("\n");
  }

  private async grepWithRipgrep(request: WorkspaceGrepRequest, executable: string): Promise<string> {
    const args = [
      "--no-config", "--color=never", "--no-heading",
      "--max-columns", String(RIPGREP_MAX_COLUMNS),
    ];
    if (request.outputMode === "files_with_matches") args.push("--files-with-matches");
    else if (request.outputMode === "count") args.push("--count");
    else {
      args.push("--line-number");
      if (request.context !== undefined) args.push("-C", String(Math.max(0, request.context)));
      if (request.beforeContext !== undefined) args.push("-B", String(Math.max(0, request.beforeContext)));
      if (request.afterContext !== undefined) args.push("-A", String(Math.max(0, request.afterContext)));
    }
    if (request.caseInsensitive) args.push("--ignore-case");
    if (request.multiline) args.push("--multiline", "--multiline-dotall");
    if (request.glob) args.push("--glob", request.glob);
    for (const skipped of [...SKIP_DIRECTORIES].sort()) args.push("--glob", `!**/${skipped}/**`);
    if (request.fileType) args.push("--type", request.fileType);
    if (this.absolutePaths) args.push("--path-separator", "/");
    const target = this.absolutePaths
      ? resolve(request.searchPath)
      : relative(this.workspaceRoot, request.searchPath) || ".";
    args.push("--regexp", request.pattern, "--", target);
    const result = await runRipgrep(executable, args, this.workspaceRoot, request.limit, request.signal);
    // A non-trivial exit with no output and no early stop is a real rg failure;
    // an early stop legitimately kills rg, so its non-zero exit is expected.
    if (result.exitCode !== 0 && result.exitCode !== 1 && result.lines.length === 0 && !result.stopReason) {
      throw new Error(`ripgrep 失败 (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`);
    }
    if (result.lines.length === 0) {
      return result.stopReason === "budget"
        ? `... (单行输出超过 ${RIPGREP_OUTPUT_BYTE_BUDGET / 1_024 / 1_024} MiB 安全上限，已提前停止，请缩小搜索范围)`
        : "No matches found.";
    }
    const lines = result.lines.map((line) => line.replace(/^\.[/\\]/u, ""));
    if (result.stopReason === "budget") {
      lines.push(`... (输出超过 ${RIPGREP_OUTPUT_BYTE_BUDGET / 1_024 / 1_024} MiB 安全上限，已提前停止，请缩小搜索范围)`);
    } else if (result.stopReason === "limit") {
      lines.push(`... (更多匹配未显示，提高 head_limit 或缩小搜索范围)`);
    }
    return lines.join("\n");
  }

  private async grepFallback(request: WorkspaceGrepRequest): Promise<string> {
    const typeExtensions = request.fileType ? TYPE_EXTENSIONS[request.fileType] : undefined;
    if (request.fileType && !typeExtensions) {
      throw new Error(`未知 type: ${request.fileType}（无 ripgrep 时支持: ${Object.keys(TYPE_EXTENSIONS).sort().join(", ")}），或改用 glob 过滤`);
    }
    // Compile before touching the workspace so invalid expressions fail immediately.
    new RegExp(request.pattern, `${request.caseInsensitive ? "i" : ""}${request.multiline ? "s" : ""}u`);
    const files = await collectFiles(this.workspaceRoot, request.searchPath, request.signal);
    const baseRelative = normalizePath(relative(this.workspaceRoot, request.searchPath));
    const results: string[] = [];
    for (let offset = 0; offset < files.length; offset += 8) {
      assertActive(request.signal);
      const batch = files.slice(offset, offset + 8);
      const matches = await Promise.all(batch.map(async (path) => {
        const displayedPath = this.displayPath(path);
        const searchRelative = baseRelative && path.startsWith(`${baseRelative}/`) ? path.slice(baseRelative.length + 1) : path;
        if (!matchesGlob(path, searchRelative, request.glob ?? "")) return [];
        if (typeExtensions && !typeExtensions.includes(extname(path).toLowerCase())) return [];
        let bytes: Uint8Array;
        try { bytes = await readFile(join(this.workspaceRoot, path)); } catch { return []; }
        if (isProbablyBinary(bytes)) return [];
        const source = new TextDecoder().decode(bytes);
        const indexes = matchingLineIndexes(source, request.pattern, request.caseInsensitive ?? false, request.multiline ?? false);
        if (indexes.length === 0) return [];
        if (request.outputMode === "files_with_matches") return [displayedPath];
        if (request.outputMode === "count") return [`${displayedPath}:${indexes.length}`];
        const lines = source.split(/\r?\n/u);
        if (request.multiline) return indexes.map((index) => `${displayedPath}:${index + 1}:${lines[index] ?? ""}`);
        const common = Math.max(0, request.context ?? 0);
        const before = Math.max(0, request.beforeContext ?? common);
        const after = Math.max(0, request.afterContext ?? common);
        const matched = new Set(indexes);
        const emitted = new Set<number>();
        const output: string[] = [];
        for (const index of indexes) {
          for (let current = Math.max(0, index - before); current <= Math.min(lines.length - 1, index + after); current += 1) {
            if (emitted.has(current)) continue;
            emitted.add(current);
            const separator = matched.has(current) ? ":" : "-";
            output.push(`${displayedPath}${separator}${current + 1}${separator}${lines[current] ?? ""}`);
          }
        }
        return output;
      }));
      for (const match of matches) results.push(...match);
      if (results.length > request.limit) break;
      await Bun.sleep(0);
    }
    if (results.length === 0) return "No matches found.";
    return limitLines(results, request.limit).join("\n");
  }
}
