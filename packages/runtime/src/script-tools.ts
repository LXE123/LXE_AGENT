import type { JsonObject } from "@lxe/protocol";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ToolRegistry } from "./tools";

export interface ScriptToolRequest {
  protocol_version: "1";
  call_id: string;
  tool_name: string;
  arguments: JsonObject;
  session: {
    session_id: string;
    response_route_id: string;
    user_id: string;
    conversation_id: string;
  };
}

export interface ScriptToolResponse {
  protocol_version: "1";
  call_id: string;
  ok: boolean;
  content: JsonObject[];
  state_patch?: JsonObject;
  files?: string[];
  error?: { code: string; message: string };
}

export interface PythonScriptToolRunnerOptions {
  command: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string | undefined>;
  onStderr?: (line: string) => void;
}

export interface ScriptToolRunner {
  execute(request: ScriptToolRequest, signal: AbortSignal, timeoutMs?: number): Promise<ScriptToolResponse>;
}

export interface ScriptToolDefinition {
  name: string;
  description: string;
  input_schema: JsonObject;
  ownerSkills?: string[];
  connectorName?: string;
  timeoutMs?: number;
  handler?: string;
  module?: string;
  exposed?: boolean;
  artifactPaths?: ArtifactPathDeclaration[];
}

export interface ArtifactPathDeclaration {
  field: string;
  role: "deliverable" | "model_input" | "diagnostic";
}

export interface RegisterScriptToolsOptions {
  runner: ScriptToolRunner;
  definitions: ScriptToolDefinition[];
  session(sessionId: string): Promise<ScriptToolRequest["session"]>;
  projectRoot?: string;
}

interface ScriptToolCatalogDocument {
  protocol_version: "1";
  entries: ScriptToolDefinition[];
}

export interface LxeSkillCommandDefinition {
  command: string;
  name: string;
  visibility: "business" | "browser" | "maintenance" | "internal";
  ownerSkills: string[];
  artifactPaths?: ArtifactPathDeclaration[];
}

const artifactPathsOf = (raw: Record<string, unknown>, entryName: string): ArtifactPathDeclaration[] => {
  const declarations = Array.isArray(raw.artifact_paths) ? raw.artifact_paths : [];
  return declarations.map((value) => {
    const item = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const field = String(item.field ?? "").trim();
    const role = String(item.role ?? "").trim() as ArtifactPathDeclaration["role"];
    if (!/^[A-Za-z_]\w*(?:\[\])?(?:\.[A-Za-z_]\w*(?:\[\])?)*$/u.test(field)
      || !["deliverable", "model_input", "diagnostic"].includes(role)) {
      throw new Error(`invalid artifact path declaration: ${entryName}`);
    }
    return { field, role };
  });
};

export function loadLxeSkillCommandCatalog(path: string): LxeSkillCommandDefinition[] {
  const document = JSON.parse(readFileSync(path, "utf8")) as ScriptToolCatalogDocument;
  if (document.protocol_version !== "1" || !Array.isArray(document.entries)) {
    throw new Error("invalid script tool catalog protocol");
  }
  return document.entries.map((entry) => {
    const raw = entry as unknown as Record<string, unknown>;
    const commandPath = Array.isArray(raw.command_path)
      ? raw.command_path.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const visibility = String(raw.visibility ?? "internal") as LxeSkillCommandDefinition["visibility"];
    if (commandPath.length === 0 || !["business", "browser", "maintenance", "internal"].includes(visibility)) {
      throw new Error(`invalid lxeskill catalog entry: ${entry.name}`);
    }
    const artifactPaths = artifactPathsOf(raw, entry.name);
    return {
      command: `lxeskill ${commandPath.join(" ")}`,
      name: entry.name,
      visibility,
      ownerSkills: Array.isArray(raw.owner_skills) ? raw.owner_skills.map((item) => String(item)) : [],
      ...(artifactPaths.length ? { artifactPaths } : {}),
    };
  });
}

export function loadScriptToolCatalog(path: string): ScriptToolDefinition[] {
  const document = JSON.parse(readFileSync(path, "utf8")) as ScriptToolCatalogDocument;
  if (document.protocol_version !== "1" || !Array.isArray(document.entries)) {
    throw new Error("invalid script tool catalog protocol");
  }
  const entries = document.entries.map((entry) => {
    const raw = entry as unknown as Record<string, unknown>;
    const artifactPaths = artifactPathsOf(raw, entry.name);
    return {
      ...entry,
      ownerSkills: Array.isArray(raw.owner_skills)
        ? raw.owner_skills.map((item) => String(item))
        : [...(entry.ownerSkills ?? [])],
      timeoutMs: Number(raw.timeout_ms ?? entry.timeoutMs ?? 0),
      ...(artifactPaths.length ? { artifactPaths } : {}),
    };
  });
  const names = new Set<string>();
  const modules = new Set<string>();
  for (const entry of entries) {
    if (!entry.name?.trim() || !entry.input_schema || !Array.isArray(entry.ownerSkills ?? [])) {
      throw new Error("invalid script tool catalog entry");
    }
    if (names.has(entry.name)) throw new Error(`duplicate script tool name: ${entry.name}`);
    names.add(entry.name);
    if (entry.module) {
      if (modules.has(entry.module)) throw new Error(`duplicate script tool module: ${entry.module}`);
      modules.add(entry.module);
      const expected = entry.module === "services.agent_cli.amazon_logistic.run"
        ? "amazon_logistic_quote"
        : entry.module === "scripts.logistics_update_ingest"
          ? "logistics_rate_import"
        : entry.module.startsWith("services.agent_cli.mabang.")
          ? `mabang_${entry.module.split(".").at(-1)}`
          : entry.module.startsWith("services.agent_cli.browser.amazon_fba.")
            ? `amazon_fba_${entry.module.split(".").at(-1)}`
            : "";
      if (!expected || expected !== entry.name) throw new Error(`script tool naming mismatch: ${entry.module} -> ${entry.name}`);
    } else if (!entry.handler) {
      throw new Error(`script tool has no handler: ${entry.name}`);
    }
  }
  return entries.filter((entry) => entry.exposed !== false).map((entry) => ({
    name: entry.name,
    description: entry.description || `Run the versioned ${entry.name} business workflow.`,
    input_schema: structuredClone(entry.input_schema),
    ownerSkills: [...(entry.ownerSkills ?? [])],
    timeoutMs: entry.timeoutMs,
    ...(entry.handler ? { handler: entry.handler } : {}),
    ...(entry.module ? { module: entry.module } : {}),
    ...(entry.artifactPaths?.length ? { artifactPaths: structuredClone(entry.artifactPaths) } : {}),
    exposed: true,
  }));
}

const readLimited = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`script output exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const terminateTree = async (pid: number): Promise<void> => {
  if (process.platform !== "win32") return;
  const taskkill = Bun.which("taskkill");
  if (!taskkill) return;
  const killer = Bun.spawn([taskkill, "/PID", String(pid), "/T", "/F"], {
    stdout: "ignore", stderr: "ignore", windowsHide: true,
  });
  await killer.exited;
};

export class PythonScriptToolRunner {
  constructor(private readonly options: PythonScriptToolRunnerOptions) {}

  async execute(request: ScriptToolRequest, signal: AbortSignal, timeoutMs?: number): Promise<ScriptToolResponse> {
    if (signal.aborted) throw new DOMException("Tool cancelled", "AbortError");
    const process = Bun.spawn(this.options.command, {
      cwd: this.options.cwd,
      env: {
        ...globalThis.process.env,
        ...this.options.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      maxBuffer: Math.max(1, this.options.maxOutputBytes),
      windowsHide: true,
    });
    let timedOut = false;
    let termination: Promise<void> | undefined;
    const terminate = (): Promise<void> => {
      if (termination) return termination;
      termination = (async () => {
        await terminateTree(process.pid);
        try {
          process.kill();
        } catch {
          // The process tree already exited.
        }
        await process.exited.catch(() => undefined);
      })();
      return termination;
    };
    const onAbort = (): void => { void terminate(); };
    signal.addEventListener("abort", onAbort, { once: true });
    const effectiveTimeoutMs = Math.max(1, Math.trunc(timeoutMs ?? this.options.timeoutMs));
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, effectiveTimeoutMs);
    try {
      process.stdin.write(`${JSON.stringify(request)}\n`);
      process.stdin.end();
      const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
        readLimited(process.stdout, this.options.maxOutputBytes),
        readLimited(process.stderr, this.options.maxOutputBytes),
        process.exited,
      ]);
      if (timedOut) throw new Error(`Python tool timed out after ${effectiveTimeoutMs}ms`);
      if (signal.aborted) throw new DOMException("Tool cancelled", "AbortError");
      const stderr = new TextDecoder().decode(stderrBytes);
      for (const line of stderr.split(/\r?\n/).filter(Boolean)) this.options.onStderr?.(line);
      const stdout = new TextDecoder().decode(stdoutBytes).trim();
      if (exitCode !== 0) throw new Error(`Python tool exited with ${exitCode}: ${stderr.trim()}`);
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) throw new Error("Python tool stdout must contain exactly one JSON response");
      const response = JSON.parse(lines[0]!) as ScriptToolResponse;
      if (response.protocol_version !== "1" || response.call_id !== request.call_id || !Array.isArray(response.content)) {
        throw new Error("invalid Python tool response");
      }
      return response;
    } catch (error) {
      await terminate();
      if (timedOut) throw new Error(`Python tool timed out after ${effectiveTimeoutMs}ms`);
      if (signal.aborted) throw new DOMException("Tool cancelled", "AbortError");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function registerScriptTools(registry: ToolRegistry, options: RegisterScriptToolsOptions): void {
  const assertFileAllowed = (rawPath: string): string => {
    if (!options.projectRoot) return rawPath;
    const root = realpathSync(options.projectRoot);
    const candidate = realpathSync(resolve(root, rawPath));
    const relation = relative(root, candidate).replaceAll("\\", "/");
    if (relation === ".." || relation.startsWith("../") || isAbsolute(relation)) {
      throw new Error(`script tool file escapes project root: ${rawPath}`);
    }
    if (!relation.startsWith("artifacts/") && !/^skills\/[^/]+\/assets\//u.test(relation)) {
      throw new Error(`script tool file is outside allowed artifact roots: ${rawPath}`);
    }
    return candidate;
  };
  for (const definition of options.definitions) {
    registry.register({
      ...definition,
      source: "script",
      exposure: "deferred",
      execute: async (arguments_, context) => {
        const callId = randomUUID();
        const session = await options.session(context.session_id);
        const response = await options.runner.execute({
          protocol_version: "1",
          call_id: callId,
          tool_name: definition.name,
          arguments: arguments_,
          session: {
            ...session,
            response_route_id: context.response_route_id ?? session.response_route_id,
          },
        }, context.handle.signal, definition.timeoutMs);
        if (!response.ok) throw new Error(response.error?.message || `${definition.name} failed`);
        return {
          content: response.content,
          ...(response.state_patch ? { state_patch: response.state_patch } : {}),
          ...(response.files ? { files: response.files.map(assertFileAllowed) } : {}),
        };
      },
    });
  }
}
