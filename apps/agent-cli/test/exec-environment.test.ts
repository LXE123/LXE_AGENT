import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecShellAdapter } from "@lxe/runtime";
import { execRuntimeEnvironment, resolveExecRuntimePaths } from "../src/exec-paths";

test("generic exec environment works without an installed Python or business CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-exec-environment-"));
  try {
    const inherited = { ...process.env, LXE_SOURCE_ROOT: root, LXE_RESOURCE_ROOT: root, LXE_DATA_ROOT: root,
      PYTHONHOME: join(root, "missing-home"), PYTHONPATH: join(root, "foreign") };
    const paths = resolveExecRuntimePaths({ environment: inherited, moduleDirectory: root });
    expect(existsSync(paths.managedPythonPath)).toBe(false);
    const environment = execRuntimeEnvironment(paths, join(root, "agent.sqlite3"), inherited);
    const shell = new ExecShellAdapter({ environment });
    const command = "echo fixture";
    expect(shell.normalizeCommand(root, command)).toBe(command);
    const spec = shell.spawnSpec(command);
    const childEnvironment = shell.childEnvironment(root, {
      workspaceDirectory: root, temporaryDirectory: root,
      sessionId: "s", turnId: "t", responseRouteId: "r", execSessionId: "e",
    });
    expect(childEnvironment.PYTHONHOME).toBeUndefined();
    expect(childEnvironment.PYTHONPATH).toBeUndefined();
    const result = spawnSync(spec.argv[0]!, spec.argv.slice(1), { cwd: root, env: childEnvironment, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("fixture");
    expect(inherited.PYTHONHOME).toContain("missing-home");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
