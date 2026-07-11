import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "@lxe/protocol";
import type { RuntimeHandle } from "./types";
import { ToolRegistry } from "./tools";

export interface CodingToolOptions {
  workspaceRoot: string;
  maxOutputChars?: number;
  sendFile?: (request: { path: string; session_id: string; response_route_id: string }) => Promise<void>;
}

type ProcessStatus = "running" | "completed" | "failed" | "timeout" | "killed";

interface ProcessEntry {
  id: string;
  command: string;
  cwd: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  process: ReturnType<typeof Bun.spawn>;
  status: ProcessStatus;
  exitCode: number | null;
  output: string;
  pending: string;
  truncated: boolean;
  completion: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
}

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const jsonResult = (payload: JsonObject) => ({ content: textBlock(JSON.stringify(payload, null, 2)) });
const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

const safePath = (root: string, value: unknown): string => {
  const requested = String(value ?? ".").trim() || ".";
  const path = resolve(root, requested);
  const rel = relative(resolve(root), path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  return path;
};

const walk = (root: string, current = root): string[] => {
  const results: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "__pycache__"].includes(entry.name)) continue;
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

export class CodingProcessManager {
  private readonly entries = new Map<string, ProcessEntry>();

  constructor(private readonly options: { maxOutputChars: number }) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].filter((entry) => entry.status === "running").map((entry) => terminateTree(entry)));
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.completion));
  }

  snapshots(): JsonObject[] {
    return [...this.entries.values()].sort((left, right) => right.startedAt - left.startedAt).map((entry) => this.snapshot(entry));
  }

  async execute(request: {
    command: string;
    cwd: string;
    sessionId: string;
    background: boolean;
    yieldMs: number;
    timeoutMs?: number;
    handle: RuntimeHandle;
  }): Promise<JsonObject> {
    const child = Bun.spawn([
      powershell(), "-NoProfile", "-NonInteractive", "-Command",
      "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; " + request.command,
    ], {
      cwd: request.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    const id = `exec_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const entry: ProcessEntry = {
      id,
      command: request.command,
      cwd: request.cwd,
      sessionId: request.sessionId,
      startedAt: Date.now() / 1_000,
      process: child,
      status: "running" as ProcessStatus,
      exitCode: null,
      output: "",
      pending: "",
      truncated: false,
      completion: Promise.resolve(),
    };
    this.entries.set(id, entry);
    const append = (value: string): void => {
      entry.pending += value;
      const next = entry.output + value;
      if (next.length > this.options.maxOutputChars) entry.truncated = true;
      entry.output = next.slice(0, this.options.maxOutputChars);
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
      stdin.write(inputText(input, "text"));
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
      output_tail: entry.output.slice(-2_000),
    };
  }
}

export function registerCodingTools(registry: ToolRegistry, options: CodingToolOptions): CodingProcessManager {
  const root = resolve(options.workspaceRoot);
  const limit = Math.max(1_000, Math.trunc(options.maxOutputChars ?? 200_000));
  const processes = new CodingProcessManager({ maxOutputChars: limit });
  registry.register({
    name: "read",
    description: "Read a UTF-8 text file from the workspace.",
    input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false },
    execute: async (input) => {
      const path = safePath(root, input.path);
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      const start = Math.max(1, Number(input.offset ?? 1));
      const count = Math.max(1, Number(input.limit ?? lines.length));
      return { content: textBlock(lines.slice(start - 1, start - 1 + count).map((line, index) => `${start + index}:${line}`).join("\n").slice(0, limit)) };
    },
  });
  registry.register({
    name: "write",
    description: "Create or overwrite a UTF-8 file inside the workspace.",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"], additionalProperties: false },
    execute: async (input) => {
      const path = safePath(root, input.file_path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, inputText(input, "content"), "utf8");
      return { content: textBlock(`Wrote ${relative(root, path)}`) };
    },
  });
  registry.register({
    name: "edit",
    description: "Replace exact text in a workspace file.",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"], additionalProperties: false },
    execute: async (input) => {
      const path = safePath(root, input.file_path);
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
      return { content: textBlock(`Edited ${relative(root, path)}`) };
    },
  });
  registry.register({
    name: "grep",
    description: "Search UTF-8 workspace files for a regular expression.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, case_insensitive: { type: "boolean" }, head_limit: { type: "integer" } }, required: ["pattern"], additionalProperties: true },
    execute: async (input) => {
      const base = safePath(root, input.path ?? ".");
      const regex = new RegExp(inputText(input, "pattern"), input.case_insensitive ? "iu" : "u");
      const files = statSync(base).isFile() ? [relative(root, base)] : walk(root, base);
      const matches: string[] = [];
      const maxLines = Math.max(1, Number(input.head_limit ?? 200));
      for (const file of files) {
        const absolute = safePath(root, file);
        let source: string;
        try { source = readFileSync(absolute, "utf8"); } catch { continue; }
        source.split(/\r?\n/).forEach((line, index) => {
          if (matches.length >= maxLines) return;
          if (regex.test(line)) matches.push(`${file}:${index + 1}:${line}`);
          regex.lastIndex = 0;
        });
        if (matches.length >= maxLines) break;
      }
      return { content: textBlock(matches.join("\n").slice(0, limit)) };
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
      const files = walk(base).filter((path) => regex.test(path.replaceAll("\\", "/")) || regex.test(basename(path))).slice(0, max);
      return { content: textBlock(files.join("\n").slice(0, limit)) };
    },
  });
  registry.register({
    name: "ls",
    description: "List workspace directory contents.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    execute: async (input) => {
      const base = safePath(root, input.path ?? ".");
      const entries = readdirSync(base, { withFileTypes: true }).map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`).sort();
      return { content: textBlock(entries.join("\n").slice(0, limit)) };
    },
  });
  registry.register({
    name: "send_file",
    description: "Send an existing workspace artifact to the current user.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async (input, context) => {
      const path = safePath(root, input.path);
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`file not found: ${input.path}`);
      if (options.sendFile) await options.sendFile({ path, session_id: context.session_id, response_route_id: context.response_route_id ?? "" });
      return { content: textBlock(`Sent ${relative(root, path)}`), files: [path] };
    },
  });
  registry.register({
    name: "exec",
    description: "Execute a PowerShell command; long-running commands become process sessions.",
    input_schema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number" }, background: { type: "boolean" }, yield_ms: { type: "number" } }, required: ["command"], additionalProperties: false },
    execute: async (input, context) => {
      const command = inputText(input, "command").trim();
      if (!command) throw new Error("command 不能为空");
      const payload = await processes.execute({
        command,
        cwd: safePath(root, input.cwd ?? "."),
        sessionId: context.session_id,
        background: input.background === true,
        yieldMs: Math.max(1, Number(input.yield_ms ?? 10_000)),
        ...(input.timeout === undefined ? { timeoutMs: 120_000 } : { timeoutMs: Math.max(1, Number(input.timeout) * 1_000) }),
        handle: context.handle,
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
