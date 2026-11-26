import { managedPythonEnvironment } from "@lxe/core";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

type Environment = Record<string, string | undefined>;

const MAX_ERROR_BYTES = 4_096;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MIN_REDACTED_LENGTH = 6;
// Desktop launches read settings, assets and local media; none of them authenticates to a business system.
const CREDENTIAL_NAME = /(?:PASSWORD|PASSWD|SECRET|TOKEN|COOKIE|SESSION|API_?KEY|AUTHORIZATION|CREDENTIALS?|MOBILE)$/iu;
// Set for the Agent's own lxeskill calls. A desktop launch is not an Agent turn.
const AGENT_ONLY_NAME = /^(?:LXE_AGENT_.*|LXESKILL_SKILL_SCOPE|LXE_USER_SKILLS_ROOT)$/iu;

export interface LxeSkillClientOptions {
  executablePath: string;
  dataRoot: string;
  managedPath: string;
  skillsRoot?: string;
  /** Arguments placed before the command; tests use it to run a fixture script through an interpreter. */
  commandPrefix?: readonly string[];
  /** The inherited environment, read at each launch. Defaults to the desktop main process. */
  environment?: () => Environment;
}

export interface LxeSkillRunOptions {
  timeoutMs: number;
  stdin?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Command-specific variables, applied after the shared ones. */
  environment?: Record<string, string>;
  onProgress?: (record: Record<string, unknown>) => void;
  onStderr?: (line: string) => void;
}

export interface LxeSkillResult {
  command: string;
  data: Record<string, unknown>;
  files: unknown[];
  record: Record<string, unknown>;
}

export class LxeSkillError extends Error {
  constructor(message: string, readonly cancelled = false) {
    super(message);
    this.name = "LxeSkillError";
  }
}

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const tail = (text: string, bytes: number): string => {
  const encoded = Buffer.from(text, "utf8");
  return encoded.length <= bytes ? text : encoded.subarray(-bytes).toString("utf8");
};

/** Remove credential values found in `environment`, then keep the last bytes of an over-long message. */
export function redactAndBound(message: string, environment: Environment = process.env): string {
  let detail = message.trim();
  for (const [name, secret] of Object.entries(environment)) {
    if (secret && secret.length >= MIN_REDACTED_LENGTH && CREDENTIAL_NAME.test(name)) {
      detail = detail.replaceAll(secret, "[redacted]");
    }
  }
  return Buffer.byteLength(detail, "utf8") <= MAX_ERROR_BYTES ? detail : `[truncated] ${tail(detail, MAX_ERROR_BYTES)}`;
}

const structuredMessage = (record: Record<string, unknown> | undefined): string => {
  const data = objectValue(record?.data);
  const candidates = [objectValue(record?.error)?.message, objectValue(data?.error)?.message, data?.exception];
  return (candidates.find(value => typeof value === "string" && value.trim()) as string | undefined)?.trim() ?? "";
};

/** Settings commands wrap their payload as `{ success: true, data }`. */
export function settingsPayload(result: LxeSkillResult): unknown {
  if (result.data.success !== true || !("data" in result.data) || result.data.data == null) {
    throw new LxeSkillError(redactAndBound(`Invalid lxeskill settings result: ${JSON.stringify(result.record)}`));
  }
  return result.data.data;
}

/**
 * The one path desktop uses to launch lxeskill commands. It owns the launch environment,
 * the JSONL protocol (progress records, then exactly one final result), and process cleanup.
 */
export class LxeSkillClient {
  constructor(private readonly options: LxeSkillClientOptions) {}

  get executablePath(): string { return this.options.executablePath; }

  environment(extra: Record<string, string> = {}): Environment {
    const inherited = { ...(this.options.environment?.() ?? process.env) };
    for (const name of Object.keys(inherited)) {
      if (CREDENTIAL_NAME.test(name) || AGENT_ONLY_NAME.test(name)) delete inherited[name];
    }
    const pathName = Object.keys(inherited).find(name => name.toUpperCase() === "PATH") ?? "PATH";
    const inheritedPath = inherited[pathName];
    delete inherited[pathName];
    const temporaryRoot = join(this.options.dataRoot, "tmp");
    return managedPythonEnvironment({
      ...inherited,
      [pathName]: [this.options.managedPath, inheritedPath].filter(Boolean).join(delimiter),
      LXE_DATA_ROOT: this.options.dataRoot,
      LXE_WORKSPACE_ROOT: join(this.options.dataRoot, "workspace"),
      LXE_MANAGED_PATH: this.options.managedPath,
      ...(this.options.skillsRoot ? { LXE_SKILLS_ROOT: this.options.skillsRoot } : {}),
      TMP: temporaryRoot,
      TEMP: temporaryRoot,
      TMPDIR: temporaryRoot,
      ...extra,
    });
  }

  async run(args: readonly string[], options: LxeSkillRunOptions): Promise<LxeSkillResult> {
    const redactionSource = this.options.environment?.() ?? process.env;
    const fail = (message: string, cancelled = false): never => {
      throw new LxeSkillError(redactAndBound(message, redactionSource), cancelled);
    };
    if (options.signal?.aborted) fail("lxeskill call was cancelled before it started", true);
    mkdirSync(join(this.options.dataRoot, "tmp"), { recursive: true });
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const child = spawn(this.options.executablePath, [...(this.options.commandPrefix ?? []), ...args], {
      cwd: this.options.dataRoot,
      env: this.environment(options.environment),
      stdio: ["pipe", "pipe", "pipe"],
      // A process group lets cancellation reach tools the command started (for example ExifTool).
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let outputBytes = 0;
    let stderr = "";
    let protocolError = "";
    let stopReason = "";
    let cancelled = false;
    let result: Record<string, unknown> | undefined;
    let spawnError: Error | undefined;
    const stop = (reason: string) => {
      if (!stopReason) stopReason = reason;
      void terminate(child);
    };
    const protocolFailure = (message: string) => {
      if (!protocolError) protocolError = message;
      stop(message);
    };

    const lines = createInterface({ input: child.stdout! });
    lines.on("line", line => {
      if (protocolError) return;
      outputBytes += Buffer.byteLength(line, "utf8") + 1;
      if (outputBytes > maxOutputBytes) return protocolFailure(`lxeskill output exceeds ${maxOutputBytes} bytes`);
      if (!line.trim()) return;
      let record: Record<string, unknown> | null;
      try { record = objectValue(JSON.parse(line)); } catch { record = null; }
      if (!record || record.protocol_version !== "1" || (record.type !== "progress" && record.type !== "result")) {
        return protocolFailure(`Invalid lxeskill output line: ${tail(line, 1_024)}`);
      }
      if (result) return protocolFailure("lxeskill wrote output after its final result");
      if (record.type === "result") { result = record; return; }
      try { options.onProgress?.(record); } catch (error) {
        protocolFailure(`lxeskill progress handling failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = tail(stderr + text, MAX_ERROR_BYTES * 4);
      if (options.onStderr) for (const line of text.split(/\r?\n/u)) if (line.trim()) options.onStderr(line);
    });
    child.stdin!.on("error", () => { /* The command may exit without reading its input. */ });
    child.stdin!.end(options.stdin ?? "");

    const timer = setTimeout(() => stop(`lxeskill timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    const onAbort = () => { cancelled = true; stop("lxeskill call was cancelled"); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("error", error => {
        spawnError = error;
        if (child.pid === undefined) resolve({ code: null, signal: null });
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      lines.close();
    });

    if (cancelled) fail("lxeskill call was cancelled", true);
    const data = objectValue(result?.data);
    const succeeded = !stopReason && !spawnError && exit.code === 0 && result?.ok === true && data !== null
      && data.success !== false;
    if (succeeded) {
      return { command: String(result!.command ?? ""), data: data!, files: Array.isArray(result!.files) ? result!.files : [], record: result! };
    }
    const structured = structuredMessage(result);
    const exitDetail = exit.code !== null && exit.code !== 0 ? `lxeskill exited with code ${exit.code}`
      : exit.signal ? `lxeskill was terminated by ${exit.signal}` : "";
    const detail = [
      structured,
      stopReason,
      spawnError?.message,
      !structured ? exitDetail : "",
      !structured && !stopReason && !spawnError && !exitDetail
        ? (result ? `Invalid lxeskill result: ${tail(JSON.stringify(result), 1_024)}` : "lxeskill produced no result") : "",
      stderr.trim(),
    ].filter(Boolean).join("\n");
    return fail(detail);
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 4_000 });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    const group = -child.pid;
    try { process.kill(group, "SIGTERM"); } catch { /* The group already exited. */ }
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 1_500);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
    try { process.kill(group, "SIGKILL"); } catch { /* The complete group already exited. */ }
  }
  try { child.kill("SIGKILL"); } catch { /* The process already exited. */ }
}

/** The client for this desktop installation's lxeskill executable and data directory. */
export const desktopLxeSkillClient = (paths: {
  lxeskillExecutablePath: string; dataRoot: string; managedPath: string; skillsRoot: string;
}): LxeSkillClient => new LxeSkillClient({
  executablePath: paths.lxeskillExecutablePath,
  dataRoot: paths.dataRoot,
  managedPath: paths.managedPath,
  skillsRoot: paths.skillsRoot,
});
