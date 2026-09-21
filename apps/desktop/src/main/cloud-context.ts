import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export class CloudContextError extends Error {
  constructor(message: string, readonly code = "cloud_context_failed", readonly httpStatus?: number) {
    super(message);
    this.name = "CloudContextError";
  }
}

export interface CloudContextQuery {
  query(serverUrl: string, signal: AbortSignal): Promise<unknown>;
}

export function contextDiagnostic(value: string): string {
  let text = value.replace(/\blxe_(?:(?:dev|client|identity)_[A-Za-z0-9]+\.|(?:erp_run|erp_handoff|erp_session|run|handoff|session)_)[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/\bBearer\s+[^\s,;"}]+/giu, "Bearer [redacted]");
  for (const [name, secret] of Object.entries(process.env)) {
    if (/token|secret|password|api.?key|authorization|cookie/iu.test(name) && secret && secret.length >= 6) text = text.replaceAll(secret, "[redacted]");
  }
  text = text.replace(/((?:token|secret|password|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*)["']?[^\s,;}"']+/giu, "$1[redacted]");
  return text.length > 4_000 ? `${text.slice(0, 4_000)} … [truncated]` : text;
}

export function parseContextResult(stdout: string, exitCode: number | null, stderr: string): unknown {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim());
  let record: any;
  try {
    if (lines.length !== 1) throw new Error("expected exactly one result");
    record = JSON.parse(lines[0]!);
    if (record?.type !== "result" || record.protocol_version !== "1" || record.command !== "cloud-context"
      || typeof record.ok !== "boolean") throw new Error("invalid result envelope");
  } catch (error) {
    throw new CloudContextError(contextDiagnostic(`Invalid cloud-context output: ${String(error)}; stdout=${stdout}; stderr=${stderr}; exit=${exitCode}`), "cloud_context_protocol_error");
  }
  if (record.ok === false && exitCode !== null && exitCode !== 0) {
    const failure = record.error;
    if (typeof failure?.code === "string" && typeof failure.message === "string") {
      throw new CloudContextError(contextDiagnostic(failure.message), failure.code,
        Number.isInteger(failure.http_status) ? failure.http_status : undefined);
    }
  }
  if (exitCode !== 0 || !record.ok || !record.data?.device_context || record.error !== undefined) {
    throw new CloudContextError(contextDiagnostic(`Inconsistent cloud-context result (exit=${exitCode}): ${stdout}; ${stderr}`), "cloud_context_protocol_error");
  }
  return record.data.device_context;
}

/** Native bootstrap query: does not depend on gateway, skill permissions or desktop secrets. */
export class DesktopCloudContextClient implements CloudContextQuery {
  constructor(private readonly options: { pythonPath: string; cwd: string; timeoutMs?: number; spawn?: typeof spawn }) {}

  query(serverUrl: string, signal: AbortSignal): Promise<unknown> {
    if (!isAbsolute(this.options.pythonPath)) return Promise.reject(new CloudContextError("Managed Python path must be absolute"));
    if (signal.aborted) return Promise.reject(new CloudContextError("cloud-context query cancelled", "cancelled"));
    const environment: NodeJS.ProcessEnv = {};
    // Python is launched by absolute path. No application credentials, proxy or PYTHONPATH inheritance.
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    return new Promise((resolve, reject) => {
      const child = (this.options.spawn ?? spawn)(this.options.pythonPath,
        ["-I", "-B", "-X", "utf8", "-m", "lxeskill", "cloud-context", "--server", serverUrl],
        { cwd: this.options.cwd, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = Buffer.alloc(0);
      let stderrTruncated = false;
      let failure: Error | undefined;
      let settled = false;
      const stop = (error: Error) => { failure ??= error; child.kill(); };
      const cancel = () => stop(new CloudContextError("cloud-context query cancelled", "cancelled"));
      const timer = setTimeout(() => stop(new CloudContextError("cloud-context process timed out after its deadline", "cloud_context_timeout")), this.options.timeoutMs ?? 15_000);
      const finish = (error?: Error, code: number | null = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        if (error || failure) { reject(error ?? failure); return; }
        try { resolve(parseContextResult(Buffer.concat(chunks).toString("utf8"), code,
          stderr.toString("utf8") + (stderrTruncated ? " … [truncated]" : ""))); }
        catch (cause) { reject(cause); }
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) stop(new CloudContextError("cloud-context stdout exceeded 2 MiB [truncated]", "cloud_context_output_limit"));
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = 4096 - stderr.length;
        stderrTruncated ||= chunk.length > remaining;
        stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      });
      child.once("error", (error) => finish(new CloudContextError(contextDiagnostic(`${error.name}: ${error.message}`), "cloud_context_spawn_failed")));
      child.once("close", (code) => finish(undefined, code));
    });
  }
}
