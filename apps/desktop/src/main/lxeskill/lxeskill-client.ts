import { managedPythonEnvironment } from "@lxe/core";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

type Environment = Record<string, string | undefined>;

const MAX_ERROR_BYTES = 4_096;
// The command's own explanation keeps this much room; stderr gets what is left of MAX_ERROR_BYTES.
const MAX_REPORTED_ERROR_BYTES = 2_048;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
// Longest stderr line, in characters, handed to an onStderr log callback.
const MAX_STDERR_LINE = 4_096;
// Short credentials are still redacted. One- or two-character values (placeholders, CLAUDE_CODE_CHILD_SESSION=1)
// and switch values are not secrets, and replacing every "1" or "T" would garble the actual error.
const MIN_SECRET_LENGTH = 3;
const FLAG_VALUE = /^(?:true|false|yes|no|on|off)$/iu;
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
  /** Receives stderr as redacted lines of at most 4,096 characters; a longer line arrives in pieces. */
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

/** The last `bytes` of `text`, without a character cut in half at the start. */
const tail = (text: string, bytes: number): string => {
  const encoded = Buffer.from(text, "utf8");
  return encoded.length <= bytes ? text : encoded.subarray(-bytes).toString("utf8").replace(/^\uFFFD+/u, "");
};

/** Credential values in `environment` that diagnostics must not show. */
const credentialValues = (environment: Environment): string[] => Object.entries(environment).flatMap(([name, secret]) => {
  const value = secret?.trim() ?? "";
  return secret && value.length >= MIN_SECRET_LENGTH && !FLAG_VALUE.test(value) && CREDENTIAL_NAME.test(name) ? [secret] : [];
});

const redact = (text: string, secrets: readonly string[]): string =>
  secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), text);

/** Remove credential values found in `environment`, then keep the last bytes of an over-long message. */
export function redactAndBound(message: string, environment: Environment = process.env, maxBytes = MAX_ERROR_BYTES): string {
  const detail = redact(message.trim(), credentialValues(environment));
  return Buffer.byteLength(detail, "utf8") <= maxBytes ? detail : `[truncated] ${tail(detail, maxBytes)}`;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Split `text` into pieces of at most `size` code units, never inside a surrogate pair. */
const pieces = (text: string, size: number): string[] => {
  const result: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length && end - start > 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    result.push(text.slice(start, end));
    start = end;
  }
  return result;
};

/**
 * Hands stderr to a log callback as redacted lines of at most MAX_STDERR_LINE characters.
 * A line without a newline is passed on in pieces, keeping back just enough text that a
 * credential split between two writes is still recognised once the rest arrives.
 */
function stderrLineWriter(environment: Environment, write: (line: string) => void) {
  const secrets = credentialValues(environment);
  const keep = Math.min(MAX_STDERR_LINE / 2, Math.max(0, ...secrets.map(secret => secret.length - 1)));
  let pending = "";
  const emit = (text: string) => {
    for (const piece of pieces(text, MAX_STDERR_LINE)) if (piece.trim()) write(piece);
  };
  return (text: string, final = false) => {
    const lines = (pending + text).split(/\r?\n/u);
    pending = final ? "" : lines.pop() ?? "";
    for (const line of lines) emit(redact(line, secrets));
    if (pending.length <= MAX_STDERR_LINE) return;
    // Every complete credential is replaced; one that is still arriving can only start in the last `keep` characters.
    const redacted = redact(pending, secrets);
    let split = redacted.length - keep;
    if (split > 0 && isHighSurrogate(redacted.charCodeAt(split - 1))) split -= 1;
    emit(redacted.slice(0, split));
    pending = redacted.slice(split);
  };
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
    if (options.signal?.aborted) throw new LxeSkillError("lxeskill call was cancelled before it started", true);
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
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settle!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { settle = resolve; });
    child.once("exit", (code, signal) => { exited = { code, signal }; });
    child.once("close", (code, signal) => settle({ code, signal }));
    child.once("error", error => {
      spawnError = error;
      if (child.pid === undefined) settle({ code: null, signal: null });
    });
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      void terminate(child).then(() => {
        // A tool the command started can keep the pipes open after the command itself exits,
        // which would hold back "close". The call is over once the process tree was told to stop.
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (exited) settle(exited);
        else child.once("exit", (code, signal) => settle({ code, signal }));
      });
    };
    const protocolFailure = (message: string) => {
      if (!protocolError) protocolError = message;
      stop(message);
    };

    // Count bytes as they arrive: a line without a newline would otherwise grow without limit.
    child.stdout!.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) protocolFailure(`lxeskill output exceeds ${maxOutputBytes} bytes`);
    });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", line => {
      if (protocolError) return;
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
    // Decode across chunks so a character split between two writes stays intact.
    const stderrDecoder = new StringDecoder("utf8");
    const logStderr = options.onStderr ? stderrLineWriter(redactionSource, options.onStderr) : undefined;
    const takeStderr = (text: string, final = false) => {
      stderr = tail(stderr + text, MAX_ERROR_BYTES * 4);
      logStderr?.(text, final);
    };
    child.stderr!.on("data", (chunk: Buffer) => takeStderr(stderrDecoder.write(chunk)));
    child.stdin!.on("error", () => { /* The command may exit without reading its input. */ });
    child.stdin!.end(options.stdin ?? "");

    const timer = setTimeout(() => stop(`lxeskill timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    const onAbort = () => { cancelled = true; stop("lxeskill call was cancelled"); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const exit = await finished.finally(() => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      lines.close();
      takeStderr(stderrDecoder.end(), true);
    });

    if (cancelled) throw new LxeSkillError("lxeskill call was cancelled", true);
    const data = objectValue(result?.data);
    const succeeded = !stopReason && !spawnError && exit.code === 0 && result?.ok === true && data !== null
      && data.success !== false;
    if (succeeded) {
      return { command: String(result!.command ?? ""), data: data!, files: Array.isArray(result!.files) ? result!.files : [], record: result! };
    }
    const structured = structuredMessage(result);
    const exitDetail = exit.code !== null && exit.code !== 0 ? `lxeskill exited with code ${exit.code}`
      : exit.signal ? `lxeskill was terminated by ${exit.signal}` : "";
    const reported = redactAndBound([
      structured,
      stopReason,
      spawnError?.message,
      !structured ? exitDetail : "",
      !structured && !stopReason && !spawnError && !exitDetail
        ? (result ? `Invalid lxeskill result: ${tail(JSON.stringify(result), 1_024)}` : "lxeskill produced no result") : "",
    ].filter(Boolean).join("\n"), redactionSource, MAX_REPORTED_ERROR_BYTES);
    // stderr is bounded separately so a long traceback cannot push the command's own explanation out.
    const diagnostics = redactAndBound(stderr, redactionSource, MAX_ERROR_BYTES - Buffer.byteLength(reported, "utf8"));
    throw new LxeSkillError([reported, diagnostics].filter(Boolean).join("\n"));
  }
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // taskkill finds the tree through the running parent; once the CLI exited, closing its pipes is what is left.
    if (hasExited(child)) return;
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 4_000 });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    // The group outlives the CLI while a tool it started is still running, so signal it even after the CLI exited.
    const group = -child.pid;
    try { process.kill(group, "SIGTERM"); } catch { /* The group already exited. */ }
    await new Promise<void>(resolve => {
      if (hasExited(child)) return resolve();
      const timer = setTimeout(resolve, 1_500);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
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
