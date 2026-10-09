import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { executionBoundary, recheckExecutionBoundary, type ExecutionBoundary } from "./boundaries";
import { ExecutionPaths } from "./execution-paths";
import type { ExecSpawnSpec } from "../tooling/exec-shell";
import type { ExecutionPolicy } from "./policy";
import { managedStateWriteSid } from "../../native/windows-sandbox/acl/workspace-sid";

export interface ExecSandboxInfo {
  backend: "none" | "seatbelt" | "windows-acl";
  mode: ExecutionPolicy["mode"];
  enforcement: "none" | "file-write" | "partial";
}
export interface SandboxedExecSpec extends ExecSpawnSpec { sandbox: ExecSandboxInfo; temporaryDirectory: string }
interface WindowsGrant { workspace: string; temporary: string; writeSid: string; tempWriteSid: string; managedStateWriteSid: string }

export function seatbeltProfile(policy: ExecutionPolicy, roots: readonly string[]): string {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', '(allow file-write* (literal "/dev/null"))'];
  if (policy.mode === "workspace-write") forms.push(`(allow file-write* ${roots.map(root => `(subpath ${JSON.stringify(root)})`).join(" ")})`);
  return forms.join(" ");
}

/** Bun owns session lifetimes; Node/Koffi materializes and revokes Windows grants. */
export class ExecSandbox {
  readonly paths: ExecutionPaths;
  private readonly grants = new Map<string, Promise<WindowsGrant>>();
  constructor(private readonly options: {
    platform?: NodeJS.Platform;
    environment?: Record<string, string | undefined>;
    paths?: ExecutionPaths;
  } = {}) {
    this.paths = options.paths ?? new ExecutionPaths(join(process.cwd(), "var"), options.platform ? { platform: options.platform } : {});
  }

  boundary(policy: ExecutionPolicy, managedStateAccess = false): ExecutionBoundary {
    return executionBoundary(policy, this.paths, managedStateAccess);
  }

  async prepare(policy: ExecutionPolicy, command: ExecSpawnSpec, expected = this.boundary(policy)): Promise<SandboxedExecSpec> {
    // This check precedes creation and grant application, including after queue admission.
    const boundary = recheckExecutionBoundary(policy, this.paths, expected);
    const temporaryDirectory = this.paths.temporaryDirectory(policy);
    if (policy.mode === "danger-full-access") return { ...command, temporaryDirectory, sandbox: { backend: "none", mode: policy.mode, enforcement: "none" } };
    if (!statSync(boundary.workspace).isDirectory()) throw new Error(`Sandbox workspace is not a directory: ${boundary.workspace}`);
    if (this.paths.platform === "darwin") {
      if (!existsSync("/usr/bin/sandbox-exec")) throw new Error("Seatbelt sandbox launcher is unavailable: /usr/bin/sandbox-exec");
      return { argv: ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(policy, [...boundary.roots, ...boundary.managedStateRoots]), ...command.argv], detached: command.detached,
        temporaryDirectory, sandbox: { backend: "seatbelt", mode: policy.mode, enforcement: "file-write" } };
    }
    if (this.paths.platform === "win32") {
      const [node, runner] = this.launcher();
      let grant: WindowsGrant | undefined;
      if (policy.mode === "workspace-write") {
        let pending = this.grants.get(policy.sessionId);
        if (!pending) {
          pending = this.prepareGrant(policy, boundary);
          this.grants.set(policy.sessionId, pending);
          void pending.catch(() => { if (this.grants.get(policy.sessionId) === pending) this.grants.delete(policy.sessionId); });
        }
        grant = await pending;
        if (grant.workspace !== boundary.workspace || grant.temporary !== temporaryDirectory) throw new Error("Windows session grant no longer matches its workspace or temporary directory");
      }
      recheckExecutionBoundary(policy, this.paths, boundary);
      return { argv: [node, runner, "--workspace", boundary.workspace, "--temp", temporaryDirectory,
        "--data-root", this.paths.dataRoot,
        "--mode", policy.mode,
        ...(grant ? ["--write-sid", grant.writeSid, "--temp-write-sid", grant.tempWriteSid] : []),
        ...(boundary.managedStateAccess && grant ? ["--state-write-sid", grant.managedStateWriteSid] : []),
        "--", ...command.argv],
        detached: false, temporaryDirectory, sandbox: { backend: "windows-acl", mode: policy.mode, enforcement: "partial" } };
    }
    throw new Error(`Exec sandbox is not implemented on ${this.paths.platform}`);
  }

  private launcher(): [string, string] {
    const env = this.options.environment ?? process.env;
    const node = env.LXE_EXEC_SANDBOX_NODE, runner = env.LXE_EXEC_SANDBOX_RUNNER;
    if (!node || !runner || !existsSync(node) || !existsSync(runner)) throw new Error(`Windows ACL sandbox launcher is unavailable: node=${node ?? "<unset>"}, runner=${runner ?? "<unset>"}`);
    return [node, runner];
  }

  private async native(action: "prepare" | "release", workspace: string, temporary: string): Promise<string> {
    const process = Bun.spawn([...this.launcher(), `--${action}-session`, workspace, temporary, this.paths.dataRoot], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code !== 0) throw new Error(`Windows sandbox ${action} failed (${code}): ${stderr || stdout}`);
    return stdout;
  }
  private async prepareGrant(policy: ExecutionPolicy, boundary: ExecutionBoundary): Promise<WindowsGrant> {
    const temporary = this.paths.temporaryDirectory(policy);
    recheckExecutionBoundary(policy, this.paths, boundary);
    mkdirSync(temporary, { recursive: true });
    try {
      recheckExecutionBoundary(policy, this.paths, boundary);
      for (const root of this.paths.managedPythonStateRoots()) mkdirSync(root, { recursive: true });
      const value = JSON.parse(await this.native("prepare", boundary.workspace, temporary)) as { writeSid: string; tempWriteSid: string; managedStateWriteSid: string };
      if (typeof value.writeSid !== "string" || typeof value.tempWriteSid !== "string" || typeof value.managedStateWriteSid !== "string") throw new Error("Invalid Windows sandbox grant response");
      if (value.managedStateWriteSid !== managedStateWriteSid(this.paths.dataRoot)) throw new Error("Invalid Windows managed-state capability identity");
      recheckExecutionBoundary(policy, this.paths, boundary);
      return { workspace: boundary.workspace, temporary, ...value };
    } catch (error) {
      try { await this.native("release", boundary.workspace, temporary); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Windows sandbox preparation and cleanup failed: ${String(error)}; ${String(cleanup)}`); }
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  async releaseSession(sessionId: string): Promise<void> {
    const pending = this.grants.get(sessionId);
    if (!pending) {
      // File tools can use the session temporary directory before any exec needs an ACL grant.
      const temporary = this.paths.sessionTemporaries().get(sessionId);
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      this.paths.forgetTemporary(sessionId);
      return;
    }
    let grant: WindowsGrant;
    try { grant = await pending; } catch { return; } // Preparation already reported and cleaned up its error.
    await this.native("release", grant.workspace, grant.temporary);
    rmSync(grant.temporary, { recursive: true, force: true });
    this.grants.delete(sessionId);
    this.paths.forgetTemporary(sessionId);
  }
  async stop(): Promise<void> {
    const results = await Promise.allSettled([...new Set([...this.grants.keys(), ...this.paths.sessionTemporaries().keys()])].map(id => this.releaseSession(id)));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  }
}
