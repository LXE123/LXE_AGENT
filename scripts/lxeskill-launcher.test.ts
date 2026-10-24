import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withExecutablePath } from "../packages/foundation/core/src/env";
import { ExecShellAdapter } from "../packages/agent/runtime/src/tooling/exec-shell";
import { prepareLxeSkillLauncher } from "./prepare-lxeskill-launcher";

test("relocated CLI entry preserves arguments, streams and status, including exec with no managed Python", () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-launcher-"));
  const windows = process.platform === "win32";
  const python = join(process.cwd(), ".venv", windows ? "Scripts/python.exe" : "bin/python");
  const wheel = join(root, "fixture_cli-1.0-py3-none-any.whl");
  const before = join(root, "before");
  const moved = join(root, "移动后的 应用");
  const directory = windows ? "Scripts" : "bin";
  const name = windows ? "lxeskill.exe" : "lxeskill";
  const run = (file: string, args: string[]) => execFileSync(file, args, { encoding: "utf8", windowsHide: true });
  try {
    // A fresh, non-editable fixture environment; no project .venv is copied.
    run(python, ["-c", `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("lxeskill/__init__.py", "")
    z.writestr("lxeskill/cli.py", '''import json, sys
def main():
    print(json.dumps(sys.argv[1:], ensure_ascii=False))
    print("fixture stderr", file=sys.stderr)
    return 23 if "--fail" in sys.argv else 0
''')
    z.writestr("lxeskill/__main__.py", "from .cli import main\\nraise SystemExit(main())\\n")
    z.writestr("fixture_cli-1.0.dist-info/METADATA", "Metadata-Version: 2.1\\nName: fixture-cli\\nVersion: 1.0\\n")
    z.writestr("fixture_cli-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")
    z.writestr("fixture_cli-1.0.dist-info/entry_points.txt", "[console_scripts]\\nlxeskill = lxeskill.cli:main\\n")
    z.writestr("fixture_cli-1.0.dist-info/RECORD", "")
`, wheel]);
    run("uv", ["venv", "--relocatable", "--no-project", "--python", python, before]);
    const interpreter = join(before, directory, windows ? "python.exe" : "python3");
    run("uv", ["pip", "install", "--python", interpreter, "--offline", "--no-deps", wheel]);
    prepareLxeSkillLauncher({ python, wheel, destination: join(before, directory, name) });
    renameSync(before, moved);
    expect(existsSync(before)).toBe(false);
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    const env = withExecutablePath({ ...process.env, PYTHONUTF8: "1", LXE_MANAGED_PYTHON: join(root, "absent-python") }, join(moved, directory));
    const args = ["中文 空格", '{"path":"C:\\中文 目录\\","quote":"a\\\"b"}', "", "a&b|c%TEMP%!", "tail\\"];
    const result = spawnSync(name, args, { cwd: workspace, env, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.stderr).toContain("fixture stderr");
    expect(spawnSync(name, ["--fail"], { cwd: workspace, env }).status).toBe(23);
    const shell = new ExecShellAdapter({ environment: env });
    for (const raw of ["lxeskill list", windows ? "lxeskill list; lxeskill describe" : "lxeskill list && lxeskill describe"]) {
      const command = shell.normalizeCommand(workspace, raw);
      expect(command).toBe(raw);
      const spec = shell.spawnSpec(command);
      const execution = spawnSync(spec.argv[0]!, spec.argv.slice(1), { cwd: workspace, env, encoding: "utf8" });
      expect(execution.status).toBe(0);
      expect(execution.stdout).toContain('["list"]');
    }
    const failedSpec = shell.spawnSpec(shell.normalizeCommand(workspace, "lxeskill --fail"));
    expect(spawnSync(failedSpec.argv[0]!, failedSpec.argv.slice(1), { cwd: workspace, env }).status).toBe(23);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
