import { execFile, type ExecFileOptions } from "node:child_process";
import { createLogger, managedPythonEnvironment } from "@lxe/core";
import type { DesktopHealth } from "@lxe/desktop-protocol";
import { redactAndBound } from "./input-assets";

interface ProbeExecution {
  stdout: string;
  stderr: string;
  error: Error | null;
}

interface LxeSkillHealthOptions {
  executablePath: string;
  dataRoot: string;
  environment: Record<string, string | undefined>;
  recovery: string;
  timeoutMs?: number;
  onChanged?: () => void;
  execute?: (file: string, args: string[], options: ExecFileOptions) => Promise<ProbeExecution>;
}

const executeProbe: NonNullable<LxeSkillHealthOptions["execute"]> = (file, args, options) =>
  new Promise(resolve => {
    let execution: ProbeExecution;
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      execution = { error, stdout: String(stdout), stderr: String(stderr) };
    });
    // Abort can invoke the callback before process exit. Shutdown must also reap the probe.
    child.once("close", () => resolve(execution));
  });

function validateListResult({ stdout, stderr, error }: ProbeExecution): void {
  const diagnostics = [error?.message, stderr.trim()].filter(Boolean).join("\n");
  let records: Record<string, any>[];
  try {
    records = stdout.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
    if (records.length === 0 || records.some(record => !record || record.protocol_version !== "1"
      || !["progress", "result"].includes(record.type))) throw new Error("invalid JSONL records");
    const terminals = records.filter(record => record.type === "result");
    if (terminals.length !== 1 || terminals[0] !== records.at(-1)) throw new Error("expected one final result");
    const result = terminals[0]!;
    if (result.command !== "list" || typeof result.ok !== "boolean" || !Array.isArray(result.files)
      || !result.data || typeof result.data !== "object"
      || (result.ok && !Array.isArray(result.data.commands))) throw new Error("invalid list result");
  } catch (cause) {
    throw new Error(`Invalid lxeskill list output: ${String(cause)}\nstdout=${stdout}\n${diagnostics}`);
  }
  const result = records.at(-1)!;
  if (error || !result.ok) {
    throw new Error([result.error?.message, diagnostics, !result.ok && !result.error?.message ? stdout : ""].filter(Boolean).join("\n"));
  }
}

/** Desktop diagnostics only: never controls whether an Agent may execute a command. */
export class DesktopLxeSkillHealth {
  private readonly logger = createLogger("desktop.lxeskill");
  private status: { state: DesktopHealth["lxeskill"]; message: string } = { state: "stopped", message: "" };
  private probe: { controller: AbortController; done: Promise<void> } | undefined;

  constructor(private readonly options: LxeSkillHealthOptions) {}

  snapshot(): { state: DesktopHealth["lxeskill"]; message: string } { return { ...this.status }; }

  check(): Promise<void> {
    if (this.probe) return this.probe.done;
    const controller = new AbortController();
    const probe = { controller, done: Promise.resolve() };
    this.probe = probe;
    this.status = { state: "starting", message: "" };
    // Queue the subprocess so the caller can start the Agent independently.
    probe.done = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      const { LXE_AGENT_SQLITE_DB_PATH: _agentDb,
        LXE_USER_SKILLS_ROOT: _userSkills, ...environment } = this.options.environment;
      const result = await (this.options.execute ?? executeProbe)(this.options.executablePath,
        ["list"], {
          cwd: this.options.dataRoot, env: managedPythonEnvironment(environment), signal: controller.signal,
          timeout: this.options.timeoutMs ?? 30_000, killSignal: "SIGKILL",
          maxBuffer: 10 * 1024 * 1024, windowsHide: true, encoding: "utf8",
        });
      if (this.probe !== probe) return;
      validateListResult(result);
      this.status = { state: "ready", message: "" };
      this.logger.info("lxeskill_probe_ready");
    }).catch(cause => {
      if (this.probe !== probe) return;
      let detail = cause instanceof Error ? cause.message : String(cause);
      for (const [name, secret] of Object.entries(this.options.environment)) {
        if (secret && /password|secret|token|cookie|api.?key|authorization/iu.test(name)) {
          detail = detail.replaceAll(secret, "[redacted]");
        }
      }
      const reason = redactAndBound(detail);
      this.status = { state: "error", message: `LXE Skill CLI is unavailable: ${reason}. ${this.options.recovery}` };
      this.logger.warn("lxeskill_probe_failed", { reason });
    }).finally(() => {
      if (this.probe !== probe) return;
      this.probe = undefined;
      this.options.onChanged?.();
    });
    this.options.onChanged?.();
    return probe.done;
  }

  async stop(): Promise<void> {
    const probe = this.probe;
    this.probe = undefined;
    probe?.controller.abort();
    this.status = { state: "stopped", message: "" };
    this.options.onChanged?.();
    await probe?.done;
  }
}
