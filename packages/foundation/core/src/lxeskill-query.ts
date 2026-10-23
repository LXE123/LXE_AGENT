import { execFile } from "node:child_process";
import { sanitizeLogValue } from "./logging";

export interface LxeSkillQueryOptions {
  pythonPath?: string;
  cwd: string;
  environment: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Read-only public CLI queries. Never reads the CLI's implementation or registry files. */
export async function queryLxeSkill(
  command: "list" | "datasets list",
  options: LxeSkillQueryOptions,
): Promise<Record<string, unknown>> {
  const { LXE_AGENT_SQLITE_DB_PATH: _agentDb, LXESKILL_SKILL_SCOPE: _scope, ...environment } = options.environment;
  const python = options.pythonPath ?? environment.LXE_MANAGED_PYTHON;
  const file = python || (process.platform === "win32" ? "lxeskill.cmd" : "lxeskill");
  const args = [...(python ? ["-I", "-B", "-X", "utf8", "-m", "lxeskill"] : []), ...command.split(" ")];
  const execution = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile(file, args, {
      cwd: options.cwd, env: environment, encoding: "utf8", windowsHide: true,
      timeout: options.timeoutMs ?? 5_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
  });
  try {
    const records = execution.stdout.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
    const results = records.filter(record => record?.type === "result");
    const result = results[0];
    if (results.length !== 1 || records.at(-1) !== result || result.protocol_version !== "1"
      || result.command !== command || result.ok !== true || !result.data || typeof result.data !== "object"
      || (command === "list" && !Array.isArray(result.data.commands))
      || (command === "datasets list" && !Array.isArray(result.data.datasets))) {
      throw new Error(`Invalid lxeskill ${command} result: ${execution.stdout}`);
    }
    if (execution.error) throw execution.error;
    return result.data;
  } catch (cause) {
    let detail = [String(cause), execution.error?.message, execution.stdout, execution.stderr].filter(Boolean).join("\n");
    for (const [key, value] of Object.entries(environment)) {
      if (value && /secret|password|token|cookie|api.?key|authorization/iu.test(key)) {
        detail = detail.replaceAll(value, "[redacted]");
      }
    }
    const sanitized = String(sanitizeLogValue(detail));
    throw new Error(sanitized.length > 4_000 ? `${sanitized.slice(0, 4_000)}\n[truncated]` : sanitized);
  }
}
