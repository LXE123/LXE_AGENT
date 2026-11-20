import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { managedPythonEnvironment } from "@lxe/core";
import { ExecutionPaths } from "../../../packages/agent/runtime/src/permissions/execution-paths";
import { ExecSandbox } from "../../../packages/agent/runtime/src/permissions/exec-sandbox";

// Real CLI + native permission integration belongs to the application tests.
const nativeTest = process.platform === "darwin" || (process.platform === "win32" && process.env.LXE_EXEC_SANDBOX_NATIVE_TEST === "1") ? test : test.skip;
nativeTest.each(["read-only", "workspace-write"] as const)("CLI help and logging degrade correctly under native %s restrictions", async mode => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".lxe-help-sandbox-")));
  const workspace = join(root, "work 中文 space");
  mkdirSync(workspace);
  const dataRoot = join(root, "data");
  const outside = join(root, "forbidden.txt");
  const bin = join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts" : "bin");
  const python = join(bin, process.platform === "win32" ? "python.exe" : "python");
  const cli = join(bin, process.platform === "win32" ? "lxeskill.exe" : "lxeskill");
  const sandbox = new ExecSandbox({ paths: new ExecutionPaths(join(root, "runtime")) });
  const policy = { mode, workspaceRoot: workspace, sessionId: root };
  const env = managedPythonEnvironment({ ...process.env, LXE_DATA_ROOT: dataRoot, LXE_WORKSPACE_ROOT: workspace,
    LOCAL_LOGS_ENABLED: "1", MABANG_ACCOUNT: "", MABANG_PASSWORD: "" });
  const run = async (argv: string[]) => {
    const spec = await sandbox.prepare(policy, { argv, detached: false });
    expect(spec.sandbox.backend).toBe(process.platform === "win32" ? "windows-acl" : "seatbelt");
    return spawnSync(spec.argv[0]!, spec.argv.slice(1), { cwd: workspace, env, encoding: "utf8", timeout: 20_000 });
  };
  try {
    // Prove enforcement really ran; a launcher bypass must not produce a false green.
    const denied = await run([python, "-B", "-c", `open(${JSON.stringify(outside)}, 'w').write('forbidden')`]);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain("PermissionError");
    expect(existsSync(outside)).toBe(false);
    for (const args of [["--help"], ["help", "fba"], ["mabang", "--help"], ["doctor", "--help"], ["mabang", "delivery", "export", "--help"]]) {
      const result = await run([cli, ...args]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("lxeskill");
      expect(result.stderr).toBe("");
      expect(existsSync(dataRoot)).toBe(false);
    }
    const logging = await run([python, "-B", "-c", "from shared.logging import setup_logging; setup_logging(); print('business-can-continue')"]);
    expect(logging.status, logging.stderr).toBe(0);
    expect(logging.stdout.trim()).toBe("business-can-continue");
    expect(logging.stderr).toContain("logging_sink_failed");
    expect(logging.stderr).toContain("PermissionError");
    expect(existsSync(dataRoot)).toBe(false);
  } finally {
    await sandbox.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 90_000);
