import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecShellAdapter } from "../../../packages/agent/runtime/src/tooling/exec-shell";
import { execRuntimeEnvironment, resolveExecRuntimePaths } from "../../agent-cli/src/exec-paths";

test("managed runtime environment isolates Python before unmodified exec commands run", () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-exec-environment-"));
  try {
    const foreign = join(root, "foreign");
    mkdirSync(join(foreign, "lxeskill"), { recursive: true });
    writeFileSync(join(foreign, "lxeskill", "__init__.py"), 'raise RuntimeError("FOREIGN_CHECKOUT_IMPORTED")\n');
    const inherited = { ...process.env, LXE_SOURCE_ROOT: process.cwd(), LXE_DATA_ROOT: root,
      PYTHONHOME: join(root, "missing-home"), PYTHONPATH: foreign };
    const paths = resolveExecRuntimePaths({ environment: inherited });
    const environment = execRuntimeEnvironment(paths, join(root, "agent.sqlite3"), inherited);
    const shell = new ExecShellAdapter({ environment });
    const command = shell.normalizeCommand(root, "lxeskill list");
    expect(command).toBe("lxeskill list");
    const spec = shell.spawnSpec(command);
    const childEnvironment = shell.childEnvironment(root, {
      workspaceDirectory: root, temporaryDirectory: root,
      sessionId: "s", turnId: "t", responseRouteId: "r", execSessionId: "e",
    });
    const result = spawnSync(spec.argv[0]!, spec.argv.slice(1), { cwd: root, env: childEnvironment, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("FOREIGN_CHECKOUT_IMPORTED");
    const terminal = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)!);
    expect(terminal.ok).toBe(true);
    expect(terminal.data.commands.length).toBeGreaterThan(0);
    // Environment preparation must not impose isolated-mode imports on ordinary
    // Python tool commands: task-local modules remain usable from the workspace.
    writeFileSync(join(root, "task_fixture.py"), 'MARKER = "task-local"\n');
    const taskPython = spawnSync(paths.managedPythonPath, ["-c", "import task_fixture; print(task_fixture.MARKER)"], {
      cwd: root, env: childEnvironment, encoding: "utf8",
    });
    expect(taskPython.status).toBe(0);
    expect(taskPython.stdout.trim()).toBe("task-local");
    expect(inherited.PYTHONHOME).toContain("missing-home");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
