import { ExecutionPaths } from "../../src/permissions/execution-paths";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, pathContains } from "@lxe/core";
import { PermissionPolicyService } from "../../src/permissions/policy";
import { ExecShellAdapter } from "../../src/tooling/exec-shell";
import { registerCodingTools } from "../../src/tooling/coding-tools";
import { ToolRegistry } from "../../src/tooling/registry";
import { workspaceFor } from "../workspace";
import { removeTemporaryRoot } from "../temp-directory";

test("real Python children keep session artifacts, venv, temporary files and output paths when cwd changes", async () => {
  // Python resolves Windows 8.3 aliases to their long names in derived paths.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lxe-workspace-exec-")));
  const worktree = repositoryRoot(import.meta.dir), dataRoot = join(root, "host");
  const cwd = join(root, "command-cwd");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "probe.py"), `
import json, os, sys, tempfile
from pathlib import Path
from shared.workspace import activate_project_workspace, artifact_root, internal_root
from lxeskill.business import allowed_output_file
activate_project_workspace()
output = artifact_root() / 'probe.txt'
output.write_text('result', encoding='utf-8')
with tempfile.NamedTemporaryFile() as temporary:
    print(json.dumps(dict(workspace=os.environ['LXE_WORKSPACE_ROOT'], artifacts=str(artifact_root()),
        output=str(allowed_output_file(str(output))), internal=str(internal_root()), temporary=temporary.name,
        venv=sys.prefix, cwd=str(Path.cwd()), scope=os.environ.get('LXESKILL_SKILL_SCOPE'),
        agent_db=os.environ.get('LXE_AGENT_SQLITE_DB_PATH'),
        tmp=[os.environ[name] for name in ['TMP', 'TEMP', 'TMPDIR']])) )
print('x' * 50000)
`);
  const executionPaths = new ExecutionPaths(dataRoot);
  const registry = new ToolRegistry();
  const processes = registerCodingTools(registry, {
    executionPaths,
    execShell: new ExecShellAdapter({ environment: { ...process.env, LXE_DATA_ROOT: dataRoot,
      LXE_AGENT_SQLITE_DB_PATH: join(dataRoot, "db", "agent.sqlite3"), LXESKILL_SKILL_SCOPE: "stale" } }),
    execEnv: () => ({ LXESKILL_SKILL_SCOPE: "selected" }),
  });
  const policies = new PermissionPolicyService();
  try {
    const results = await Promise.all(["one", "two"].map(async sessionId => {
      const directory = join(root, sessionId);
      mkdirSync(directory);
      const workspace = workspaceFor(directory, worktree);
      const executionPolicy = policies.resolve({ session_id: sessionId, workspace, permission_mode: "danger-full-access" });
      const result = await registry.execute("exec", { command: "python probe.py", cwd, "yield-time-ms": 10_000 }, {
        session_id: sessionId, workspace, executionPolicy,
        handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} },
      });
      const text = String(result.content[0]?.text);
      expect(text).toContain("status: completed");
      const spillPath = text.match(/^output_path: (.+)$/mu)?.[1];
      if (!spillPath) throw new Error(text);
      expect(pathContains(executionPaths.outputDirectory(executionPolicy), spillPath)).toBe(true);
      const transcript = readFileSync(spillPath, "utf8");
      const record = JSON.parse(transcript.match(/^\{.+\}$/mu)![0]);
      expect(record).toMatchObject({ workspace: executionPolicy.workspaceRoot, artifacts: executionPaths.artifactRoot(executionPolicy),
        output: join(executionPaths.artifactRoot(executionPolicy), "probe.txt"), internal: join(dataRoot, "lxeskill"),
        venv: join(worktree, ".venv"), cwd, scope: "selected", agent_db: null,
        tmp: Array(3).fill(executionPaths.temporaryDirectory(executionPolicy)) });
      expect(pathContains(executionPaths.temporaryDirectory(executionPolicy), record.temporary)).toBe(true);
      expect(readFileSync(record.output, "utf8")).toBe("result");
      return record;
    }));
    expect(results[0].artifacts).not.toBe(results[1].artifacts);
    expect(results[0].temporary).not.toBe(results[1].temporary);
  } finally { await processes.stop(); await removeTemporaryRoot(root); }
}, 30_000);
