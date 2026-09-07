import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonObject } from "@lxe/protocol";

export const FD_VERSION = "10.5.0";
export const findSchema: JsonObject = {
  type: "object", properties: {
    pattern: { type: "string", minLength: 1, description: "Glob; patterns containing / match full paths, not necessarily anchored at the search root." },
    path: { type: "string", minLength: 1, pattern: "\\S" },
    limit: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1000 },
  }, required: ["pattern"], additionalProperties: false,
};
export function validateFindInput(value: unknown): { pattern: string; path: string; limit: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("find input must be an object.");
  const input = value as Record<string, unknown>;
  if ("head_limit" in input) throw new Error('find head_limit was removed; use {"pattern":"*.ts","limit":1000}.');
  for (const key of Object.keys(input)) if (!["pattern", "path", "limit"].includes(key)) throw new Error(`find unknown parameter: ${key}.`);
  if (typeof input.pattern !== "string" || !input.pattern.length) throw new Error("find pattern must be a non-empty string.");
  if ("path" in input && (typeof input.path !== "string" || !input.path.trim())) throw new Error("find path must be a non-empty, non-blank string.");
  const limit = "limit" in input ? input.limit : 1000;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) throw new Error("find limit must be a positive safe integer.");
  return { pattern: input.pattern, path: typeof input.path === "string" ? input.path : ".", limit };
}

export interface FdRequest {
  pattern: string;
  searchPath: string;
  limit: number;
  signal?: AbortSignal;
  outputLimit?: number;
}
export interface FdOptions {
  fdPath?: string | null;
  absolutePaths?: boolean;
  /** Injectable timeout for process lifecycle tests. */
  timeoutMs?: number;
}

export function resolveFdExecutable(configured?: string | null): string {
  if (configured !== undefined) {
    if (!configured) throw new Error("fd is unavailable. Prepare the pinned fd runtime before using find.");
    return configured;
  }
  if (process.env.LXE_FD_PATH) return process.env.LXE_FD_PATH;
  // Source checkouts have a managed binary prepared before development/test runs.
  let root = resolve(process.env.LXE_SOURCE_ROOT || process.cwd());
  for (;;) {
    if (existsSync(join(root, "config", "desktop-runtime", "fd.lock.json"))) {
      const managed = join(root, "build", "desktop-runtime", `${process.platform}-${process.arch}`, "tools", process.platform === "win32" ? "fd.exe" : "fd");
      if (existsSync(managed)) return managed;
      break;
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  const system = Bun.which("fd") || Bun.which("fdfind");
  if (system) return system;
  throw new Error("fd is unavailable. Run bun run desktop:tools:fd to prepare fd 10.5.0, or configure LXE_FD_PATH.");
}

export function checkFdVersion(executable: string): void {
  const result = Bun.spawnSync([executable, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`fd --version failed (exit ${result.exitCode}): ${result.stderr.toString() || result.stdout.toString()}`);
  const actual = result.stdout.toString().trim();
  if (actual !== `fd ${FD_VERSION}`) throw new Error(`fd version mismatch: expected fd ${FD_VERSION}, received ${actual || "empty output"}.`);
}

async function insideGitRepository(path: string): Promise<boolean> {
  for (let current = path;; current = dirname(current)) {
    try { await stat(join(current, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; }
    if (dirname(current) === current) return false;
  }
}
// fd's Windows full-path matcher uses native separators. Replacing / with a
// character class breaks globstar's zero-directory rule, so enumerate those
// alternatives before translating separators. Flatten user braces as well:
// globset cannot reliably express nested/empty alternatives here.
export function windowsFdGlob(pattern: string): string {
  const maximum = 256;
  const expandBraces = (text: string): string[] => {
    let bracket = false;
    let opening = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "[") bracket = true;
      if (text[i] === "]") bracket = false;
      if (!bracket && text[i] === "{") { opening = i; break; }
    }
    if (opening < 0) return [text];
    let depth = 0;
    let start = opening + 1;
    const choices: string[] = [];
    for (let i = opening + 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "[") bracket = true;
      if (text[i] === "]") bracket = false;
      if (bracket) continue;
      if (text[i] === "{") depth++;
      if (text[i] === "}" && depth-- === 0) {
        choices.push(text.slice(start, i));
        const result: string[] = [];
        for (const choice of choices) {
          result.push(...expandBraces(text.slice(0, opening) + choice + text.slice(i + 1)));
          if (result.length > maximum) throw new Error("find Windows glob exceeds 256 expanded alternatives; simplify the pattern.");
        }
        return result;
      }
      if (text[i] === "," && depth === 0) { choices.push(text.slice(start, i)); start = i + 1; }
    }
    return [text]; // Let fd report malformed glob syntax.
  };
  const variants: string[] = [];
  for (const alternative of expandBraces(pattern)) {
    let prefixes = [""];
    const parts = alternative.split("/");
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!;
      const suffix = i < parts.length - 1 ? "/" : "";
      prefixes = prefixes.flatMap(prefix => segment === "**" && suffix ? [prefix, prefix + "**/"] : [prefix + segment + suffix]);
      if (prefixes.length + variants.length > maximum) throw new Error("find Windows glob exceeds 256 expanded alternatives; simplify the pattern.");
    }
    variants.push(...prefixes);
  }
  const translated = [...new Set(variants)].map(value => value.replaceAll("/", String.raw`[/\\]`));
  return translated.length === 1 ? translated[0]! : `{${translated.join(",")}}`;
}

export function fdArguments(request: FdRequest, inGit: boolean, platform = process.platform): string[] {
  const args = ["--glob", "--hidden", "--color=never", "--absolute-path", "--print0", "--show-errors", "--max-results", String(request.limit)];
  if (!inGit) args.push("--no-require-git");
  let pattern = request.pattern;
  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/")) pattern = `**/${pattern}`;
    if (platform === "win32") pattern = windowsFdGlob(pattern);
  }
  args.push("--", pattern, request.searchPath);
  return args;
}
export function escapeFindPath(path: string): string {
  return path.replace(/[\\\p{Cc}\p{Cf}\u2028\u2029]/gu, character => {
    if (character === "\\") return "\\\\";
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    const code = character.codePointAt(0)!;
    return code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
  });
}

export async function findWithFd(workspaceRoot: string, request: FdRequest, options: FdOptions = {}): Promise<string> {
  request.signal?.throwIfAborted();
  const info = await stat(request.searchPath);
  if (!info.isDirectory()) throw Object.assign(new Error(`ENOTDIR: find requires a directory: ${request.searchPath}`), { code: "ENOTDIR" });
  const physicalSearchRoot = await realpath(request.searchPath);
  const inGit = await insideGitRepository(request.searchPath);
  request.signal?.throwIfAborted();
  const executable = resolveFdExecutable(options.fdPath);
  checkFdVersion(executable);
  request.signal?.throwIfAborted();
  const budget = request.outputLimit ?? 10_000;
  const reserved = 2048;
  if (budget <= reserved) throw new Error("find output budget is too small for status and diagnostics.");
  const child = Bun.spawn([executable, ...fdArguments(request, inGit)], { cwd: workspaceRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const kill = () => { try { child.kill(); } catch { /* process already exited */ } };
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  const onAbort = () => kill();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) kill();
  const stderrPromise = (async () => {
    const chunks: Uint8Array[] = [];
    let retained = 0;
    let truncated = false;
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      const room = 65536 - retained;
      if (chunk.length > room) truncated = true;
      if (room > 0) { const kept = chunk.subarray(0, room); chunks.push(kept); retained += kept.length; }
    }
    return Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[stderr truncated at 64 KiB]" : "");
  })();
  const lines: string[] = [];
  let used = 0;
  let pending = Buffer.alloc(0);
  let stopReason = "";
  let fatal = "";
  try {
    reading: for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      // Bound a single unfinished NUL record, independent of the requested result count.
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(0, start);
        const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
        if (pending.length + piece.length > 1_048_576) { fatal = "fd output record exceeded the 1 MiB buffer limit; search incomplete."; kill(); break reading; }
        pending = Buffer.concat([pending, piece]);
        if (end < 0) break;
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(pending);
        pending = Buffer.alloc(0);
        start = end + 1;
        if (!raw) continue;
        const physical = isAbsolute(raw) ? raw : resolve(workspaceRoot, raw);
        // fd canonicalizes its search root (e.g. /var -> /private/var on macOS).
        // Restore the caller's root spelling without resolving individual links.
        const suffix = relative(physicalSearchRoot, physical);
        const absolute = suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix)
          ? resolve(request.searchPath, suffix) : physical;
        let displayed = options.absolutePaths ? absolute : relative(workspaceRoot, absolute);
        if (process.platform === "win32") displayed = displayed.replaceAll("\\", "/");
        const line = escapeFindPath(displayed);
        if (line.length + 1 > budget - reserved) { fatal = "A complete find path cannot fit in the output character budget; narrow the search."; kill(); break reading; }
        if (used + line.length + 1 > budget - reserved) { stopReason = "Output character limit reached. Narrow the search path or pattern."; kill(); break reading; }
        lines.push(line); used += line.length + 1;
        if (lines.length >= request.limit) { stopReason = `Result limit (${request.limit}) reached; more results may exist. Increase limit or narrow the search.`; kill(); break reading; }
      }
    }
    const exitCode = await child.exited;
    const stderr = await stderrPromise;
    request.signal?.throwIfAborted();
    if (timedOut) throw new Error(`fd timed out after ${timeoutMs} ms; search incomplete.${stderr ? `\n${stderr}` : ""}`);
    if (fatal) throw new Error(`${fatal}${stderr ? `\n${stderr}` : ""}`);
    if (pending.length && !stopReason) throw new Error(`fd returned an incomplete NUL-delimited path.${stderr ? `\n${stderr}` : ""}`);
    const failed = exitCode !== 0 && !stopReason;
    if (!lines.length && (failed || stderr)) throw new Error(`fd search failed (exit ${exitCode}): ${stderr || "no stderr output"}`);
    const notices = [stopReason];
    if (stderr || failed) notices.push(`Search incomplete.${failed ? ` fd exited with ${exitCode}.` : ""}${stderr ? `\n${stderr}` : ""}`);
    let footer = notices.filter(Boolean).join("\n");
    if (footer.length > reserved - 1) footer = `${footer.slice(0, reserved - 70)}\n[diagnostics truncated to fit output budget]`;
    return [...(lines.length ? lines : ["No entries found."]), ...(footer ? [footer] : [])].join("\n");
  } finally {
    kill();
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    await Promise.allSettled([child.exited, stderrPromise]);
  }
}
