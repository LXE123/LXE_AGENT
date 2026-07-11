import type { JsonObject } from "@lxe/protocol";
import { randomUUID } from "node:crypto";
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
  execute(request: ScriptToolRequest, signal: AbortSignal): Promise<ScriptToolResponse>;
}

export interface ScriptToolDefinition {
  name: string;
  description: string;
  input_schema: JsonObject;
  ownerSkills?: string[];
  connectorName?: string;
  timeoutMs?: number;
}

export interface RegisterScriptToolsOptions {
  runner: ScriptToolRunner;
  definitions: ScriptToolDefinition[];
  session(sessionId: string): Promise<ScriptToolRequest["session"]>;
}

export const ZINIAO_SCRIPT_TOOL_DEFINITIONS: ScriptToolDefinition[] = [
  {
    name: "ziniao_browser",
    description: "Manage Ziniao store lifecycle. Reuse a running store when possible.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open_store", "get_status", "exit_store"] },
        store_id: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    ownerSkills: ["fba-shipment-create"],
  },
  {
    name: "ziniao_page",
    description: "Observe and control one Ziniao store page.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["browser_snapshot", "browser_vision", "browser_navigate", "browser_click", "browser_type", "browser_scroll"] },
        store_id: { type: "string" },
        full: { type: "boolean" },
        url: { type: "string" },
        ref: { type: "string" },
        text: { type: "string" },
        direction: { type: "string", enum: ["up", "down"] },
        pixels: { type: "integer", minimum: 100, maximum: 4_000 },
      },
      required: ["action", "store_id"],
      additionalProperties: false,
    },
    ownerSkills: ["fba-shipment-create"],
  },
];

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

  async execute(request: ScriptToolRequest, signal: AbortSignal): Promise<ScriptToolResponse> {
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
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, Math.max(1, this.options.timeoutMs));
    try {
      process.stdin.write(`${JSON.stringify(request)}\n`);
      process.stdin.end();
      const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
        readLimited(process.stdout, this.options.maxOutputBytes),
        readLimited(process.stderr, this.options.maxOutputBytes),
        process.exited,
      ]);
      if (timedOut) throw new Error(`Python tool timed out after ${this.options.timeoutMs}ms`);
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
      if (timedOut) throw new Error(`Python tool timed out after ${this.options.timeoutMs}ms`);
      if (signal.aborted) throw new DOMException("Tool cancelled", "AbortError");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function registerScriptTools(registry: ToolRegistry, options: RegisterScriptToolsOptions): void {
  for (const definition of options.definitions) {
    registry.register({
      ...definition,
      source: "script",
      exposure: "deferred",
      execute: async (arguments_, context) => {
        const callId = randomUUID();
        const response = await options.runner.execute({
          protocol_version: "1",
          call_id: callId,
          tool_name: definition.name,
          arguments: arguments_,
          session: await options.session(context.session_id),
        }, context.handle.signal);
        if (!response.ok) throw new Error(response.error?.message || `${definition.name} failed`);
        return {
          content: response.content,
          ...(response.state_patch ? { state_patch: response.state_patch } : {}),
          ...(response.files ? { files: response.files } : {}),
        };
      },
    });
  }
}
