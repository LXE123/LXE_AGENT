import {
  type BigIntStats,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger, runWithLogContext } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";
import type { RuntimeHandle } from "../engine/types";
import { detectReadImageMime, ModelImageProcessor } from "../providers/model-image";
import {
  appendLimitedBytes,
  appendTailBytes,
  combineProcessStreams,
  decodeProcessOutput,
  formatCommandPayload,
} from "./process-output";
import {
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  DEFAULT_EXEC_YIELD_MS,
  ExecShellAdapter,
  MAX_EXEC_TIMEOUT_SECONDS,
} from "./exec-shell";
import { isProbablyBinary, WorkspaceSearchService } from "./workspace-search";
import { classifyLxeSkillInput, matchLxeSkillInvocation } from "./lxeskill-command";
import type { LxeSkillRuntimeStatus } from "../operations/lxeskill-runtime";
import { scanNumberedTextChunks, type NumberedTextRangeResult } from "./text-range";
import {
  ToolExecutionError,
  ToolRegistry,
  type LxeSkillInvocationErrorDetails,
  type LxeSkillInvocationViolation,
} from "./registry";

export interface LxeSkillRecoveryCommand {
  command: string;
  module?: string;
  ownerSkills: readonly string[];
}

export interface CodingToolOptions {
  workspaceRoot: string;
  repositorySkillsRoot?: string;
  artifactRoot?: string;
  homeDirectory?: string;
  maxOutputChars?: number;
  sendFile?: (request: { path: string; session_id: string; response_route_id: string }) => Promise<void>;
  onProcessComplete?: (snapshot: JsonObject) => Promise<void> | void;
  ripgrepPath?: string | null;
  businessCommands?: ReadonlyMap<string, readonly string[]>;
  businessCommandCatalog?: readonly LxeSkillRecoveryCommand[];
  execShell?: ExecShellAdapter;
  execEnv?: (context: { skillNames: readonly string[] }) => Record<string, string>;
  lxeSkillStatus?: () => LxeSkillRuntimeStatus;
}

type ProcessStatus = "running" | "completed" | "failed" | "timeout" | "killed";

interface ProcessEntry {
  id: string;
  command: string;
  cwd: string;
  sessionId: string;
  turnId: string;
  responseRouteId: string;
  startedAt: number;
  endedAt?: number;
  process: ReturnType<typeof Bun.spawn>;
  explicitBackground: boolean;
  status: ProcessStatus;
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  pendingStdout: Uint8Array;
  pendingStderr: Uint8Array;
  stdoutTail: Uint8Array;
  stderrTail: Uint8Array;
  truncated: boolean;
  completion: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  notifyOnExit: boolean;
  terminationEvents: Set<"process_killed" | "process_force_killed">;
}

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const commandResult = (payload: JsonObject) => ({ content: textBlock(formatCommandPayload(payload)) });
const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

const BUSINESS_MODULE_PATTERN = /\b(?:services\.agent_cli(?:\.[A-Za-z_]\w*)+|browser_auth_service\.main)\b/giu;
const LXESKILL_TOKEN_PATTERN = /\blxeskill(?:\.cmd)?\b/iu;
const LXESKILL_MODULE_WRAPPER_PATTERN = /-m\s+lxeskill\b/iu;
const SHELL_COMPOSITION_PATTERN = /[\r\n]|&&|\|\||[;|`<>]|\$\(/u;

const lxeSkillInvocationError = (
  rawCommand: string,
  knownCommands: ReadonlyMap<string, readonly string[]>,
  commandCatalog: readonly LxeSkillRecoveryCommand[],
): ToolExecutionError | undefined => {
  const violations: LxeSkillInvocationViolation[] = [];
  const modules = [...rawCommand.matchAll(BUSINESS_MODULE_PATTERN)].map((match) => String(match[0] ?? ""));
  const hasBusinessModule = modules.length > 0;
  const hasPythonModuleWrapper = LXESKILL_MODULE_WRAPPER_PATTERN.test(rawCommand);
  const hasLxeSkillToken = LXESKILL_TOKEN_PATTERN.test(rawCommand);
  const directLxeSkill = /^lxeskill(?:\.cmd)?(?:\s|$)/iu.test(rawCommand.trim());
  const concernsLxeSkill = hasBusinessModule || hasPythonModuleWrapper || hasLxeSkillToken;

  if (hasBusinessModule) violations.push("direct_business_module");
  if (hasPythonModuleWrapper) violations.push("python_module_wrapper");
  if (hasLxeSkillToken && !directLxeSkill) violations.push("not_standalone");
  if (concernsLxeSkill && SHELL_COMPOSITION_PATTERN.test(rawCommand)) violations.push("shell_composition");
  if (violations.length === 0) return undefined;

  const embeddedCommand = rawCommand.match(/\blxeskill(?:\.cmd)?\b[\s\S]*/iu)?.[0];
  const invocation = embeddedCommand
    ? matchLxeSkillInvocation(embeddedCommand, knownCommands)
    : undefined;
  const moduleEntry = modules
    .map((module) => commandCatalog.find((entry) => entry.module?.toLowerCase() === module.toLowerCase()))
    .find((entry): entry is LxeSkillRecoveryCommand => Boolean(entry));
  const catalogEntry = invocation
    ? commandCatalog.find((entry) => entry.command.toLowerCase() === invocation.command.toLowerCase())
    : moduleEntry;
  const canonicalCommand = invocation?.command ?? catalogEntry?.command;
  const ownerSkills = invocation?.ownerSkills?.length
    ? invocation.ownerSkills
    : catalogEntry?.ownerSkills.length ? [...catalogEntry.ownerSkills] : undefined;
  const details: LxeSkillInvocationErrorDetails = {
    type: "lxeskill_invocation_error",
    violations,
    required_command_shape: "lxeskill <command> [options]",
    use_exec_cwd: true,
    ...(canonicalCommand ? {
      canonical_command_path: canonicalCommand,
      describe_command: canonicalCommand.replace(/^lxeskill\s+/iu, "lxeskill describe "),
    } : { discovery_command: "lxeskill list" }),
    ...(ownerSkills?.length ? { owner_skills: [...ownerSkills] } : {}),
  };
  const code = hasBusinessModule || hasPythonModuleWrapper
    ? "permission_denied"
    : "unsupported_invocation";
  return new ToolExecutionError(
    code,
    "Invalid lxeskill invocation: exec.command must contain exactly one standalone lxeskill command; use exec.cwd for the working directory and do not use uv, python -m, cd, pipes, redirects, or shell operators.",
    details,
    "lxeskill_invocation",
  );
};
const processLines = (value: string): string[] => {
  if (!value) return [];
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const PROTECTED_ROOT_FILES = new Set([
  ".env", ".env.local", ".envrc", ".env.development", ".env.production", ".env.test", ".env.staging",
]);
// Program-managed state the model must never write into. var/tmp stays
// writable (scratch), as does the root artifacts/ send_file output surface.
const PROTECTED_PATH_PREFIXES = ["var/db", "var/logs"];
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

const containsCanonicalPath = (root: string, path: string): boolean =>
  containsPath(root, path)
  && containsPath(canonicalCandidate(root), canonicalCandidate(path));

const safePath = (root: string, value: unknown): string => {
  const requested = String(value ?? ".").trim() || ".";
  const path = resolve(root, requested);
  if (!containsPath(root, path) || !containsPath(realpathSync(root), canonicalCandidate(path))) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  return path;
};

type ReadableScopeKind = "workspace" | "skills" | "artifacts";

interface ReadableScope {
  root: string;
  kind: ReadableScopeKind;
}

interface ReadableTarget {
  path: string;
  scope: ReadableScope;
}

const requestedPath = (root: string, home: string, requested: string): string => {
  if (requested === "~") return home;
  if (/^~[\\/]/u.test(requested)) return resolve(home, requested.slice(2));
  return resolve(root, requested);
};

const readableTarget = (
  root: string,
  home: string,
  scopes: readonly ReadableScope[],
  value: unknown,
): ReadableTarget => {
  const requested = String(value ?? "").trim();
  if (!requested) throw new Error("path is required");
  const path = requestedPath(root, home, requested);
  const scope = scopes.find((candidate) => containsCanonicalPath(candidate.root, path));
  if (scope) return { path, scope };
  throw new Error(`path escapes workspace and approved read-only roots: ${requested}`);
};

const displayReadablePath = (workspaceRoot: string, target: ReadableTarget): string =>
  target.scope.kind === "workspace"
    ? relative(workspaceRoot, target.path).replaceAll("\\", "/") || "."
    : target.path.replaceAll("\\", "/");

const isSkillAsset = (skillRoot: string, path: string): boolean => {
  if (!containsPath(skillRoot, path)) return false;
  const parts = relative(skillRoot, path).replaceAll("\\", "/").split("/");
  const assetsIndex = parts.lastIndexOf("assets");
  if (assetsIndex <= 0 || assetsIndex >= parts.length - 1) return false;
  const assetRoot = resolve(skillRoot, ...parts.slice(0, assetsIndex + 1));
  return containsCanonicalPath(assetRoot, path);
};

const assertWritable = (root: string, path: string): void => {
  const rel = relative(root, path);
  const parts = rel.split(/[\\/]+/u);
  if (parts.length === 1 && PROTECTED_ROOT_FILES.has(parts[0]!.toLowerCase())) {
    throw new Error(`write denied for protected workspace file: ${rel}`);
  }
  const normalized = rel.replaceAll("\\", "/").toLowerCase();
  const protectedPrefix = PROTECTED_PATH_PREFIXES.find(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
  if (protectedPrefix) {
    throw new Error(`write denied for protected workspace directory: ${protectedPrefix}/`);
  }
};

const truncateHeadTail = (value: string, limit: number): { value: string; truncated: boolean } => {
  if (value.length <= limit) return { value, truncated: false };
  const marker = `\n... (truncated, ${value.length} chars total) ...\n`;
  const available = Math.max(2, limit - marker.length);
  const head = Math.floor(available / 2);
  return { value: `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`, truncated: true };
};

const fileVersionFromStats = (info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }): string =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;

const currentFileVersion = (path: string): string | undefined => {
  try { return fileVersionFromStats(statSync(path, { bigint: true })); } catch { return undefined; }
};

// Files at or below this size take the simple read-whole-then-slice path, which
// preserves exact `split(/\r?\n/)` semantics. Larger files are scanned in
// chunks so a range read never pulls the whole file into memory or splits it.
const SMALL_READ_BYTES = 512 * 1_024;
const READ_CHUNK_BYTES = 256 * 1_024;
const DEFAULT_LARGE_READ_LINES = 2_000;
const READ_HINT_CHAR_RESERVE = 160;

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

const assertFileVersionUnchanged = async (path: string, expected: string): Promise<void> => {
  let actual: string | undefined;
  try { actual = fileVersionFromStats(await stat(path, { bigint: true })); } catch { /* Treated as a version change. */ }
  if (actual !== expected) {
    throw new Error(`read 期间文件发生变化，请重新读取最新内容: ${path}`);
  }
};

class FileReadLedger {
  private readonly entries = new Map<string, string>();
  private readonly maximum = 10_000;

  recordVersion(sessionId: string, path: string, version: string): void {
    const key = `${sessionId}\0${path}`;
    this.entries.delete(key);
    this.entries.set(key, version);
    while (this.entries.size > this.maximum) this.entries.delete(this.entries.keys().next().value!);
  }

  recordCurrent(sessionId: string, path: string): void {
    const version = currentFileVersion(path);
    if (version !== undefined) this.recordVersion(sessionId, path, version);
  }

  assertCurrent(sessionId: string, path: string, action: string): void {
    const key = `${sessionId}\0${path}`;
    const recorded = this.entries.get(key);
    if (recorded === undefined) throw new Error(`${action} 被拒绝：请先用 read 读取该文件再修改: ${path}`);
    const current = currentFileVersion(path);
    if (current !== recorded) {
      throw new Error(`${action} 被拒绝：文件在上次 read 之后被修改过，请重新 read 确认最新内容: ${path}`);
    }
  }
}

export class CodingProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly logger = createLogger("runtime.coding_process");

  constructor(private readonly options: {
    maxOutputBytes: number;
    maxPendingBytes: number;
    tailBytes: number;
    ttlSeconds: number;
    workspaceRoot: string;
    shell: ExecShellAdapter;
  }) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].filter((entry) => entry.status === "running").map((entry) => {
      entry.status = "killed";
      return this.terminateObserved(entry, "process_force_killed");
    }));
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
    env?: Record<string, string>;
  }): Promise<JsonObject> {
    this.sweep();
    const id = `exec_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      const spawn = this.options.shell.spawnSpec(request.command);
      child = Bun.spawn(spawn.argv, {
        cwd: request.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: spawn.detached,
        windowsHide: true,
        env: {
          ...this.options.shell.childEnvironment(this.options.workspaceRoot, {
            sessionId: request.sessionId,
            responseRouteId: request.responseRouteId,
            turnId: request.turnId ?? "",
            execSessionId: id,
          }),
          ...request.env,
        },
      });
    } catch (error) {
      runWithLogContext({
        session_id: request.sessionId,
        turn_id: request.turnId ?? "",
        response_route_id: request.responseRouteId,
        task_id: id,
      }, () => this.logger.error("process_spawn_failed", {
        task_id: id,
        cwd: request.cwd,
        error,
      }));
      return {
        status: "failed",
        session: id,
        error: error instanceof Error && error.message ? `${error.name}: ${error.message}` : String(error),
      };
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || typeof stdout === "number" || !stderr || typeof stderr === "number") {
      try { child.kill(); } catch { /* failed process has no usable stream to clean up */ }
      runWithLogContext(this.logContext({
        id,
        sessionId: request.sessionId,
        turnId: request.turnId ?? "",
        responseRouteId: request.responseRouteId,
      }), () => this.logger.error("process_spawn_failed", {
        task_id: id,
        cwd: request.cwd,
        error: new Error("spawned process did not expose stdout/stderr pipes"),
      }));
      return { status: "failed", session: id, error: "spawned process did not expose stdout/stderr pipes" };
    }
    const entry: ProcessEntry = {
      id,
      command: request.command,
      cwd: request.cwd,
      sessionId: request.sessionId,
      turnId: request.turnId ?? "",
      responseRouteId: request.responseRouteId,
      startedAt: Date.now() / 1_000,
      process: child,
      explicitBackground: request.background,
      status: "running" as ProcessStatus,
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      pendingStdout: new Uint8Array(),
      pendingStderr: new Uint8Array(),
      stdoutTail: new Uint8Array(),
      stderrTail: new Uint8Array(),
      truncated: false,
      completion: Promise.resolve(),
      notifyOnExit: request.background,
      terminationEvents: new Set(),
    };
    this.entries.set(id, entry);
    runWithLogContext(this.logContext(entry), () => {
      this.logger.info("process_started", this.processFields(entry));
    });
    const append = (value: Uint8Array, isStderr: boolean): void => {
      if (isStderr) {
        const output = appendLimitedBytes(entry.stderr, value, this.options.maxOutputBytes);
        const pending = appendLimitedBytes(entry.pendingStderr, value, this.options.maxPendingBytes);
        entry.stderr = output.bytes;
        entry.pendingStderr = pending.bytes;
        entry.stderrTail = appendTailBytes(entry.stderrTail, value, this.options.tailBytes);
        entry.truncated ||= output.truncated || pending.truncated;
        return;
      }
      const output = appendLimitedBytes(entry.stdout, value, this.options.maxOutputBytes);
      const pending = appendLimitedBytes(entry.pendingStdout, value, this.options.maxPendingBytes);
      entry.stdout = output.bytes;
      entry.pendingStdout = pending.bytes;
      entry.stdoutTail = appendTailBytes(entry.stdoutTail, value, this.options.tailBytes);
      entry.truncated ||= output.truncated || pending.truncated;
    };
    const pump = async (stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> => {
      const reader = stream.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        append(chunk.value, isStderr);
      }
    };
    const stdoutTask = pump(stdout, false);
    const stderrTask = pump(stderr, true);
    entry.completion = runWithLogContext(this.logContext(entry), async () => {
      const exitCode = await child.exited;
      await Promise.allSettled([stdoutTask, stderrTask]);
      entry.exitCode = exitCode;
      entry.endedAt = Date.now() / 1_000;
      if (entry.status === "running") entry.status = exitCode === 0 ? "completed" : "failed";
      if (entry.timeout) clearTimeout(entry.timeout);
      this.logger.info("process_completed", this.processFields(entry));
      if (entry.notifyOnExit && this.onComplete) {
        try {
          await this.onComplete(this.snapshot(entry));
        } catch (error) {
          this.logger.warn("process_notification_failed", { ...this.processFields(entry), error });
        }
      }
    });
    if (!request.background && request.timeoutMs) {
      entry.timeout = setTimeout(() => {
        if (entry.status !== "running") return;
        entry.status = "timeout";
        void runWithLogContext(this.logContext(entry), async () => {
          this.logger.warn("process_timeout", this.processFields(entry));
          await this.options.shell.terminate(entry.process, false);
        });
      }, request.timeoutMs);
    }
    if (request.background) {
      runWithLogContext(this.logContext(entry), () => {
        this.logger.info("process_yielded_to_background", this.processFields(entry));
      });
      return this.runningPayload(entry);
    }

    const unregister = request.handle.registerProcess({
      kill: () => this.terminateObserved(entry, "process_killed"),
      forceKill: () => this.terminateObserved(entry, "process_force_killed"),
    });
    const abort = (): void => {
      entry.status = "killed";
      void this.terminateObserved(entry, "process_killed");
    };
    request.handle.signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([entry.completion, Bun.sleep(request.yieldMs)]);
      if (entry.status === "running") {
        entry.notifyOnExit = true;
        runWithLogContext(this.logContext(entry), () => {
          this.logger.info("process_yielded_to_background", this.processFields(entry));
        });
      }
      return entry.status === "running" ? this.runningPayload(entry) : this.completedPayload(entry);
    } finally {
      request.handle.signal.removeEventListener("abort", abort);
      unregister();
    }
  }

  async process(input: JsonObject): Promise<JsonObject> {
    const action = inputText(input, "action").trim();
    if (action === "list") {
      this.sweep();
      const sessions = [...this.entries.values()]
        .sort((left, right) => right.startedAt - left.startedAt)
        .map((entry) => ({
          session: entry.id,
          command: entry.command.slice(0, 100),
          status: entry.status,
          pid: entry.process.pid,
          duration_sec: this.duration(entry),
        }));
      return { sessions, message: sessions.length === 0 ? "没有活跃或最近的会话。" : "" };
    }
    const id = inputText(input, "session").trim();
    const entry = this.entries.get(id);
    if (!id) return { error: "需要指定 session 参数。" };
    if (!entry) return { error: `会话 ${id} 不存在。` };
    if (action === "poll") {
      if (entry.status === "running" && entry.pendingStdout.byteLength === 0 && entry.pendingStderr.byteLength === 0) {
        await Promise.race([entry.completion, Bun.sleep(5_000)]);
      }
      const payload: JsonObject = {
        session: entry.id,
        status: entry.status,
        new_output: combineProcessStreams(entry.pendingStdout, entry.pendingStderr) || "(no new output)",
      };
      entry.pendingStdout = new Uint8Array();
      entry.pendingStderr = new Uint8Array();
      if (entry.status !== "running") {
        payload.exit_code = entry.exitCode;
        payload.duration_sec = this.duration(entry);
      }
      if (entry.truncated) payload.truncated = true;
      return payload;
    }
    if (action === "log") {
      const stdoutLines = processLines(decodeProcessOutput(entry.stdout));
      const stderrLines = processLines(decodeProcessOutput(entry.stderr));
      const offset = Math.max(0, Number(input.offset ?? 1) - 1);
      const limit = Math.max(1, Math.min(Number(input.limit ?? 2_000), 10_000));
      const totalLines = Math.max(stdoutLines.length, stderrLines.length);
      const showingEnd = Math.min(totalLines, offset + limit);
      const output = combineProcessStreams(
        new TextEncoder().encode(stdoutLines.slice(offset, offset + limit).join("\n")),
        new TextEncoder().encode(stderrLines.slice(offset, offset + limit).join("\n")),
      ) || "(no output)";
      const payload: JsonObject = {
        session: entry.id,
        total_lines: totalLines,
        showing: totalLines ? `${offset + 1}-${showingEnd}` : "0-0",
        output,
      };
      if (showingEnd < totalLines) payload.message = `还有 ${totalLines - showingEnd} 行。用 offset=${showingEnd + 1} 继续。`;
      if (entry.truncated) payload.truncated = true;
      return payload;
    }
    if (action === "write") {
      const text = inputText(input, "text");
      if (!text) return { error: "write 操作需要 text 参数。" };
      if (entry.status !== "running") return { error: `会话 ${id} 已结束，无法写入。` };
      const stdin = entry.process.stdin;
      if (!stdin || typeof stdin === "number") return { error: `会话 ${id} 不支持写入。` };
      try {
        stdin.write(`${text}\n`);
        return { status: "ok", session: id, message: `已写入 ${Buffer.byteLength(`${text}\n`)} 字节。` };
      } catch (error) {
        return { error: `写入失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (action === "kill") {
      if (entry.status !== "running") return { message: `会话 ${id} 已经结束（${entry.status}）。` };
      entry.status = "killed";
      await this.terminateObserved(entry, "process_killed");
      await entry.completion;
      return { status: "killed", session: id };
    }
    if (action === "remove") {
      if (entry.status === "running") {
        entry.status = "killed";
        await this.terminateObserved(entry, "process_killed");
        await entry.completion;
      }
      this.entries.delete(id);
      return { status: "removed", session: id };
    }
    return { error: `未知 action: ${action}` };
  }

  private duration(entry: ProcessEntry): number {
    return Math.max(0, (entry.endedAt ?? Date.now() / 1_000) - entry.startedAt);
  }

  private completedPayload(entry: ProcessEntry): JsonObject {
    return {
      status: entry.status,
      session: entry.id,
      exit_code: entry.exitCode,
      output: combineProcessStreams(entry.stdout, entry.stderr).trim() || "(no output)",
      duration_sec: this.duration(entry),
      ...(entry.truncated ? { truncated: true } : {}),
    };
  }

  private runningPayload(entry: ProcessEntry): JsonObject {
    const message = entry.explicitBackground
      ? `命令仍在运行。除非用户明确要求，否则不要用 process(action='poll', session='${entry.id}') 查看进度。`
      : `命令仍在运行，完成后会自动通知你，请继续处理其他工作，不要轮询等待。只有需要查看中间进度时才用 process(action='poll', session='${entry.id}')。`;
    return {
      status: entry.status,
      session: entry.id,
      pid: entry.process.pid,
      message,
      tail: combineProcessStreams(entry.stdoutTail, entry.stderrTail) || "(暂无输出)",
      ...(entry.truncated ? { truncated: true } : {}),
    };
  }

  private snapshot(entry: ProcessEntry): JsonObject {
    const endedAt = entry.endedAt ?? null;
    return {
      task_id: entry.id,
      session: entry.id,
      session_id: entry.sessionId,
      response_route_id: entry.responseRouteId,
      session_title: "",
      origin_turn_id: entry.turnId,
      card_id: "",
      status: entry.status,
      pid: entry.process.pid,
      command: entry.command,
      cwd: entry.cwd,
      started_at: entry.startedAt,
      ended_at: endedAt,
      duration_sec: this.duration(entry),
      background: entry.status === "running",
      exit_code: entry.exitCode,
      truncated: entry.truncated,
      output_tail: combineProcessStreams(entry.stdoutTail, entry.stderrTail),
    };
  }

  private sweep(): void {
    const cutoff = Date.now() / 1_000 - this.options.ttlSeconds;
    for (const [id, entry] of this.entries) {
      if (entry.status !== "running" && (entry.endedAt ?? Number.POSITIVE_INFINITY) < cutoff) this.entries.delete(id);
    }
  }

  private logContext(entry: Pick<ProcessEntry, "sessionId" | "turnId" | "responseRouteId" | "id">) {
    return {
      session_id: entry.sessionId,
      turn_id: entry.turnId,
      response_route_id: entry.responseRouteId,
      task_id: entry.id,
    };
  }

  private processFields(entry: ProcessEntry): JsonObject {
    return {
      pid: entry.process.pid,
      task_id: entry.id,
      status: entry.status,
      duration_ms: Math.max(0, Math.round(((entry.endedAt ?? Date.now() / 1_000) - entry.startedAt) * 1_000)),
      exit_code: entry.exitCode,
      truncated: entry.truncated,
      cwd: entry.cwd,
    };
  }

  private terminateObserved(
    entry: ProcessEntry,
    event: "process_killed" | "process_force_killed",
  ): Promise<void> {
    return runWithLogContext(this.logContext(entry), async () => {
      if (!entry.terminationEvents.has(event)) {
        entry.terminationEvents.add(event);
        this.logger.warn(event, this.processFields(entry));
      }
      await this.options.shell.terminate(entry.process, event === "process_force_killed");
    });
  }

  onComplete: ((snapshot: JsonObject) => Promise<void> | void) | undefined;
}

export function registerCodingTools(registry: ToolRegistry, options: CodingToolOptions): CodingProcessManager {
  const root = resolve(options.workspaceRoot);
  const toolOutputLimit = 10_000;
  const processOutputLimit = Math.max(1_000, Math.trunc(options.maxOutputChars ?? 200_000));
  const ledger = new FileReadLedger();
  const imageProcessor = new ModelImageProcessor();
  const home = resolve(options.homeDirectory ?? homedir());
  const userSkillsRoot = resolve(home, ".agents", "skills");
  const scopesByRoot = new Map<string, ReadableScope>();
  for (const scope of [
    { root, kind: "workspace" as const },
    ...(options.repositorySkillsRoot
      ? [{ root: resolve(options.repositorySkillsRoot), kind: "skills" as const }]
      : []),
    { root: userSkillsRoot, kind: "skills" as const },
    ...(options.artifactRoot
      ? [{ root: resolve(options.artifactRoot), kind: "artifacts" as const }]
      : []),
  ]) {
    if (!scopesByRoot.has(scope.root)) scopesByRoot.set(scope.root, scope);
  }
  const readableScopes = [...scopesByRoot.values()];
  const searchOptions = options.ripgrepPath === undefined ? {} : { ripgrepPath: options.ripgrepPath };
  const searches = new Map(readableScopes.map((scope) => [
    scope.root,
    new WorkspaceSearchService(scope.root, {
      ...searchOptions,
      absolutePaths: scope.kind !== "workspace",
    }),
  ]));
  const searchFor = (target: ReadableTarget): WorkspaceSearchService => {
    const search = searches.get(target.scope.root);
    if (!search) throw new Error(`search root is unavailable: ${target.scope.root}`);
    return search;
  };
  const execShell = options.execShell ?? new ExecShellAdapter();
  const commandCatalog = options.businessCommandCatalog ?? [];
  const businessCommands = options.businessCommands ?? new Map(
    commandCatalog.map((entry) => [entry.command, [...entry.ownerSkills]] as const),
  );
  const processes = new CodingProcessManager({
    maxOutputBytes: processOutputLimit,
    maxPendingBytes: 30_000,
    tailBytes: 2_000,
    ttlSeconds: 1_800,
    workspaceRoot: root,
    shell: execShell,
  });
  processes.onComplete = options.onProcessComplete;
  registry.register({
    name: "read",
    description: "Read a text or image file from the workspace, bundled skills, runtime artifacts, or ~/.agents/skills. External roots are read-only. Reading records the file version required by edit/write.",
    input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false },
    execute: async (input, context) => {
      const path = readableTarget(root, home, readableScopes, input.path).path;
      let info: BigIntStats;
      try { info = await stat(path, { bigint: true }); } catch { throw new Error(`file not found: ${input.path}`); }
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
      ledger.recordCurrent(context.session_id, path);
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
      ledger.recordCurrent(context.session_id, path);
      return { content: textBlock(`Edited ${relative(root, path)}`) };
    },
  });
  registry.register({
    name: "grep",
    description: "Search UTF-8 files in the workspace or an explicitly addressed read-only skill/artifact root for a regular expression.",
    input_schema: { type: "object", properties: {
      pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, type: { type: "string" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      case_insensitive: { type: "boolean" }, context: { type: "integer" }, before_context: { type: "integer" },
      after_context: { type: "integer" }, multiline: { type: "boolean" }, head_limit: { type: "integer" },
    }, required: ["pattern"], additionalProperties: false },
    execute: async (input, context) => {
      const target = readableTarget(root, home, readableScopes, input.path ?? ".");
      const pattern = inputText(input, "pattern");
      if (!pattern) throw new Error("pattern 不能为空");
      const maxLines = Math.max(1, Number(input.head_limit ?? 100));
      const mode = String(input.output_mode ?? "files_with_matches");
      if (!["files_with_matches", "content", "count"].includes(mode)) throw new Error(`未知 output_mode: ${mode}`);
      const output = await searchFor(target).grep({
        pattern,
        searchPath: target.path,
        outputMode: mode as "files_with_matches" | "content" | "count",
        glob: inputText(input, "glob"),
        fileType: inputText(input, "type"),
        caseInsensitive: input.case_insensitive === true,
        ...(input.context === undefined ? {} : { context: Math.max(0, Number(input.context)) }),
        ...(input.before_context === undefined ? {} : { beforeContext: Math.max(0, Number(input.before_context)) }),
        ...(input.after_context === undefined ? {} : { afterContext: Math.max(0, Number(input.after_context)) }),
        multiline: input.multiline === true,
        limit: maxLines,
        signal: context.handle.signal,
      });
      return { content: textBlock(truncateHeadTail(output, toolOutputLimit).value) };
    },
  });
  registry.register({
    name: "find",
    description: "Find files in the workspace or an explicitly addressed read-only skill/artifact root by glob-like pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, head_limit: { type: "integer" } }, required: ["pattern"], additionalProperties: false },
    execute: async (input, context) => {
      const target = readableTarget(root, home, readableScopes, input.path ?? ".");
      const pattern = inputText(input, "pattern");
      if (!pattern) throw new Error("pattern 不能为空");
      const max = Math.max(1, Number(input.head_limit ?? 200));
      const output = await searchFor(target).find({
        pattern,
        searchPath: target.path,
        limit: max,
        signal: context.handle.signal,
      });
      return { content: textBlock(truncateHeadTail(output, toolOutputLimit).value) };
    },
  });
  registry.register({
    name: "ls",
    description: "List directory contents in the workspace or an explicitly addressed read-only skill/artifact root.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    execute: async (input) => {
      const target = readableTarget(root, home, readableScopes, input.path ?? ".");
      const entries = readdirSync(target.path, { withFileTypes: true }).map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`).sort();
      return { content: textBlock(truncateHeadTail(entries.join("\n"), toolOutputLimit).value) };
    },
  });
  registry.register({
    name: "send_file",
    description: "Send an existing workspace/runtime artifact or a bundled skill asset to the current user.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async (input, context) => {
      const target = readableTarget(root, home, readableScopes, input.path);
      const path = target.path;
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`file not found: ${input.path}`);
      const artifactRoots = [
        join(root, "artifacts"),
        ...(options.artifactRoot ? [resolve(options.artifactRoot)] : []),
      ];
      const skillRoots = [
        join(root, "skills"),
        ...(options.repositorySkillsRoot ? [resolve(options.repositorySkillsRoot)] : []),
        userSkillsRoot,
      ];
      const artifact = artifactRoots.some((artifactRoot) => containsCanonicalPath(artifactRoot, path));
      const skillAsset = skillRoots.some((skillRoot) => isSkillAsset(skillRoot, path));
      if (!artifact && !skillAsset) {
        throw new Error("send_file only allows workspace/runtime artifacts or skill assets/**");
      }
      if (options.sendFile) await options.sendFile({ path, session_id: context.session_id, response_route_id: context.response_route_id ?? "" });
      return { content: textBlock(`Sent ${displayReadablePath(root, target)}`), files: [path] };
    },
  });
  registry.register({
    name: "exec",
    description: "Execute shell commands with background continuation. Windows uses PowerShell; macOS/Linux use /bin/sh without loading user profiles. Python and pip use this project's .venv; lxeskill prefers the precompiled project runtime and falls back to .venv in development. A lxeskill invocation must be the only command in command; use cwd instead of cd and do not wrap it with uv, python -m, pipes, redirects, or shell operators.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command string. For lxeskill, provide exactly one standalone `lxeskill <command> [options]`; do not use uv, python -m, cd, newlines, pipes, redirects, &&, ||, semicolons, backticks, or $(). Use cwd for the working directory. Help/list/describe commands follow the same rule.",
        },
        cwd: { type: "string", description: "Working directory inside the workspace; defaults to the workspace root." },
        timeout: {
          type: "number", minimum: 1, maximum: MAX_EXEC_TIMEOUT_SECONDS, default: DEFAULT_EXEC_TIMEOUT_SECONDS,
          description: "Foreground timeout in seconds (default 120, maximum 3600). Ignored when background=true.",
        },
        background: { type: "boolean", default: false, description: "Start in the background immediately." },
        yield_ms: {
          type: "number", minimum: 1, default: DEFAULT_EXEC_YIELD_MS,
          description: "Milliseconds to wait before a still-running foreground command moves to the background.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    classifyInvocation: (input) => {
      const invocation = classifyLxeSkillInput(input, businessCommands);
      if (!invocation) return undefined;
      return {
        usageName: `lxeskill:${invocation.commandId}`,
        commandId: invocation.commandId,
        ...(invocation.ownerSkills?.length ? { ownerSkills: invocation.ownerSkills } : {}),
      };
    },
    execute: async (input, context) => {
      const rawCommand = inputText(input, "command");
      if (!rawCommand.trim()) throw new Error("command 不能为空");
      // The standalone/composition rules keep lxeskill invocations parseable for
      // usage attribution and card display; command authorization itself belongs
      // to the CLI, which rejects unknown or out-of-scope commands with a
      // structured error.
      const ownerIsVisible = (ownerSkills: readonly string[]): boolean =>
        ownerSkills.length === 0
        || !context.exposureState
        || ownerSkills.some((owner) => context.exposureState?.allowsSkill(owner));
      const recoveryCommands = new Map(
        [...businessCommands].filter(([, ownerSkills]) => ownerIsVisible(ownerSkills)),
      );
      const recoveryCatalog = commandCatalog.filter((entry) => ownerIsVisible(entry.ownerSkills));
      const invocationError = lxeSkillInvocationError(rawCommand, recoveryCommands, recoveryCatalog);
      if (invocationError) throw invocationError;
      if (/^lxeskill(?:\.cmd)?(?:\s|$)/iu.test(rawCommand.trim())) {
        const status = options.lxeSkillStatus?.();
        if (status && !status.available) {
          throw new ToolExecutionError(
            "environment_unavailable",
            status.message || "LXE Skill CLI is unavailable",
            {
              type: "lxeskill_runtime_unavailable",
              retryable: false,
              next_action: "report_environment_failure_without_retrying_shell_variations",
              operator_recovery: status.recovery,
            },
          );
        }
      }
      const background = input.background === true;
      const timeoutSeconds = Number(input.timeout ?? DEFAULT_EXEC_TIMEOUT_SECONDS);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_EXEC_TIMEOUT_SECONDS) {
        throw new Error(`timeout must be between 1 and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
      }
      const yieldMs = Number(input.yield_ms ?? DEFAULT_EXEC_YIELD_MS);
      if (!Number.isFinite(yieldMs) || yieldMs < 1) throw new Error("yield_ms must be a positive number of milliseconds");
      const command = execShell.normalizeCommand(root, rawCommand);
      const payload = await processes.execute({
        command,
        cwd: safePath(root, input.cwd ?? "."),
        sessionId: context.session_id,
        responseRouteId: context.response_route_id ?? "",
        background,
        yieldMs,
        ...(!background ? { timeoutMs: timeoutSeconds * 1_000 } : {}),
        handle: context.handle,
        ...(context.turn_id === undefined ? {} : { turnId: context.turn_id }),
        ...(options.execEnv ? { env: options.execEnv({ skillNames: context.skill_names ?? [] }) } : {}),
      });
      return commandResult(payload);
    },
  });
  registry.register({
    name: "process",
    description: "Manage exec sessions: list, poll, log, write, kill, or remove.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["list", "poll", "log", "write", "kill", "remove"] }, session: { type: "string" }, text: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["action"], additionalProperties: false },
    execute: async (input) => commandResult(await processes.process(input)),
  });
  return processes;
}
