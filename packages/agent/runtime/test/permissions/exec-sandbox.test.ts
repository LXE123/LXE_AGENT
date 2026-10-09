import { PermissionApprovalService } from "../../src/permissions/approvals";
import { registerCodingTools } from "../../src/tooling/coding/register";
import { ToolRegistry } from "../../src/tooling/registry";
import { executionBoundary, recheckExecutionBoundary, type ExecutionBoundary } from "../../src/permissions/boundaries";
import { ExecutionPaths } from "../../src/permissions/execution-paths";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode } from "@lxe/protocol";
import { PermissionPolicyService } from "../../src/permissions/policy";
import { ExecSandbox, seatbeltProfile } from "../../src/permissions/exec-sandbox";
import { CodingProcessManager } from "../../src/tooling/coding/process-manager";
import { ExecShellAdapter } from "../../src/tooling/exec-shell";
import { loadLxeSkillCommandCatalog } from "../../src/tooling/lxeskill-command";
import { workspaceFor } from "../workspace";

const roots: string[] = [];
const managers: CodingProcessManager[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".lxe-exec-sandbox-")));
  roots.push(root);
  const workspace = join(root, "work 中文 space");
  mkdirSync(workspace);
  const service = new PermissionPolicyService();
  const policy = (mode: PermissionMode, id = "first") => service.resolve({
    session_id: `${root}:${id}`, workspace: workspaceFor(workspace, root), permission_mode: mode,
  });
  return { root, workspace, policy, paths: new ExecutionPaths(join(root, "var")) };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("full access bypasses unavailable backends; restricted calls fail explicitly", async () => {
  const { policy } = fixture(), command = { argv: ["program"], detached: false };
  const backend = new ExecSandbox({ platform: "linux", environment: {} });
  expect(await backend.prepare(policy("danger-full-access"), command)).toMatchObject({ ...command, sandbox: { backend: "none" } });
  await expect(backend.prepare(policy("workspace-write"), command)).rejects.toThrow("not implemented on linux");
  await expect(new ExecSandbox({ platform: "win32", environment: {} }).prepare(policy("workspace-write"), command)).rejects.toThrow("launcher is unavailable");
});
test("Seatbelt grants fixed workspace and canonical system temporary regions with safe quoting", () => {
  const { policy, paths } = fixture(), p = policy("workspace-write");
  const mac = new ExecutionPaths(paths.dataRoot, { platform: "darwin" });
  const roots = executionBoundary(p, mac).roots;
  const profile = seatbeltProfile(p, roots);
  expect(profile).toContain('(deny file-write*)');
  for (const root of roots) expect(profile).toContain(`(subpath ${JSON.stringify(root)})`);
  expect(seatbeltProfile(policy("read-only"), roots)).not.toContain("subpath");
  expect(seatbeltProfile(p, ['a"b'])).toContain(JSON.stringify('a"b'));
});
test("unrelated artifact links do not affect execution boundaries", () => {
  const { root, workspace, policy, paths } = fixture();
  const p = policy("workspace-write"), initial = executionBoundary(p, paths);
  symlinkSync(root, join(workspace, ".lxeagent"), process.platform === "win32" ? "junction" : "dir");
  expect(() => recheckExecutionBoundary(p, paths, initial)).not.toThrow();
});

test("ordinary commands do not resolve unused application-private state paths", () => {
  if (process.platform === "win32") return;
  const { root, policy } = fixture();
  const unused = join(root, "unused-private-state");
  symlinkSync(unused, unused);
  const paths = new ExecutionPaths(unused);
  expect(() => executionBoundary(policy("workspace-write"), paths)).not.toThrow();
  expect(() => executionBoundary(policy("read-only"), paths)).not.toThrow();
  expect(() => executionBoundary(policy("workspace-write"), paths, true)).toThrow("Too many symbolic links");
});

test("managed Python state is a separate fixed capability and never includes Bun state", () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".lxe-python-state-boundary-")));
  roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const dataRoot = join(root, "private-data"); mkdirSync(dataRoot);
  const p = new PermissionPolicyService().resolve({
    session_id: "python-state-boundary",
    workspace: workspaceFor(workspace, root),
    permission_mode: "workspace-write",
  });
  const paths = new ExecutionPaths(dataRoot, { platform: "darwin", temporaryRoot: tmpdir() });
  const ordinary = executionBoundary(p, paths);
  expect(ordinary.managedStateAccess).toBe(false);
  expect(ordinary.managedStateRoots).toEqual([]);

  const business = executionBoundary(p, paths, true);
  expect(business.managedStateAccess).toBe(true);
  expect(business.managedStateRoots.map((path) => path.replaceAll("\\", "/"))).toEqual([
    `${dataRoot}/lxeskill`,
    `${dataRoot}/db/lxeskill`,
    `${dataRoot}/logs`,
  ]);
  expect(business.managedStateRoots).not.toContain(join(dataRoot, "db"));
  expect(business.managedStateRoots).not.toContain(join(dataRoot, "db", "agent.sqlite3"));
  expect(executionBoundary({ ...p, mode: "read-only" }, paths, true).managedStateRoots).toEqual([]);
  expect(executionBoundary({ ...p, mode: "danger-full-access" }, paths, true).managedStateRoots).toEqual([]);
});

test("managed Python state does not conflict with the Desktop application temp root", () => {
  const { policy, paths } = fixture();
  const p = policy("workspace-write");
  const desktopPaths = new ExecutionPaths(paths.dataRoot, {
    platform: "darwin",
    temporaryRoot: join(paths.dataRoot, "tmp"),
  });

  const boundary = executionBoundary(p, desktopPaths, true);

  expect(boundary.roots).toContain(join(paths.dataRoot, "tmp"));
  expect(boundary.managedStateRoots.map((path) => path.replaceAll("\\", "/"))).toEqual([
    `${paths.dataRoot}/lxeskill`,
    `${paths.dataRoot}/db/lxeskill`,
    `${paths.dataRoot}/logs`,
  ]);
});

test("managed Python state roots cannot escape the trusted data root through a symlink", () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".lxe-python-state-link-")));
  roots.push(root);
  const workspace = join(root, "workspace"), dataRoot = join(root, "private-data"), outside = join(root, "outside");
  mkdirSync(workspace); mkdirSync(dataRoot); mkdirSync(outside);
  mkdirSync(join(dataRoot, "db"));
  symlinkSync(outside, join(dataRoot, "db", "lxeskill"));
  const p = new PermissionPolicyService().resolve({
    session_id: "python-state-link",
    workspace: workspaceFor(workspace, root),
    permission_mode: "workspace-write",
  });
  const paths = new ExecutionPaths(dataRoot, { platform: "darwin", temporaryRoot: tmpdir() });
  expect(() => executionBoundary(p, paths, true)).toThrow("escaped its data root");
});

test("business CLI reuses an already writable project or temporary boundary", () => {
  const { root, policy, paths } = fixture();
  const projectPolicy = { ...policy("workspace-write"), workspaceRoot: root };
  const covered = executionBoundary(projectPolicy, paths, true);
  expect(covered.managedStateRoots).toEqual([]);
  expect(covered.roots).toContain(root);
  const temporaryPaths = new ExecutionPaths(join(tmpdir(), "lxe-already-covered-state"), { platform: "darwin" });
  expect(executionBoundary(policy("workspace-write"), temporaryPaths, true).managedStateRoots).toEqual([]);
});

const native = process.platform === "darwin" || (process.platform === "win32" && process.env.LXE_EXEC_SANDBOX_NATIVE_TEST === "1");
const nativeTest = native ? test : test.skip;
const quote = (text: string) => process.platform === "win32" ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", `'"'"'`)}'`;
const node = process.env.LXE_EXEC_SANDBOX_NODE || Bun.which("node") || "";
const invokeNode = (script: string) => `${process.platform === "win32" ? "& " : ""}${quote(node)} ${quote(script)}`;

function manager(paths?: ExecutionPaths) {
  if (!paths) { const root = mkdtempSync(join(process.cwd(), ".lxe-exec-output-")); roots.push(root); paths = new ExecutionPaths(root); }
  const value = new CodingProcessManager({ maxOutputBytes: 100_000, tailBytes: 2_000, shell: new ExecShellAdapter(), sandbox: new ExecSandbox({ paths }) });
  managers.push(value);
  return value;
}

function execute(m: CodingProcessManager, p: ReturnType<ReturnType<typeof fixture>["policy"]>, command: string, cwd = p.workspaceRoot, yieldMs = 10_000, boundary?: ExecutionBoundary) {
  return m.execute({ ...(boundary ? { boundary } : {}), executionPolicy: p, workspace: workspaceFor(p.workspaceRoot), command, cwd, sessionId: p.sessionId,
    responseRouteId: "test", toolCallId: "test", turnId: "test", yieldMs, signal: new AbortController().signal });
}

nativeTest.each(["read-only", "workspace-write"] as const)("native %s enforces writes through PowerShell/sh and Node", async mode => {
  const { root, workspace, policy } = fixture();
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "original");
  const script = join(workspace, "probe.cjs");
  writeFileSync(script, `const fs = require('node:fs'), path = require('node:path');
    const targets = { workspace: path.join(${JSON.stringify(workspace)}, 'written'), temporary: path.join(process.env.TMPDIR, 'written-'+process.pid), outside: ${JSON.stringify(outside)} };
    const result = { read: fs.readFileSync(targets.outside, 'utf8'), cwd: process.cwd(), tmp: process.env.TMPDIR, errors: {} };
    for (const [key, target] of Object.entries(targets)) { try { fs.writeFileSync(target, 'changed'); result[key] = true; if(key==='temporary') fs.unlinkSync(target); } catch (e) { result[key] = false; result.errors[key] = e.message; } }
    fs.writeSync(1, JSON.stringify(result)); fs.writeSync(2, 'real-stderr');`);
  const result = await execute(manager(), policy(mode), invokeNode(script), root);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(result.exit_code).toBe(0);
  const output = String(result.output);
  expect(output).toContain('"read":"original"');
  expect(output).toContain(`"workspace":${mode === "workspace-write"}`);
  expect(output).toContain(`"temporary":${mode === "workspace-write"}`);
  expect(output).toContain('"outside":false');
  expect(output).toContain("real-stderr");
  expect(readFileSync(outside, "utf8")).toBe("original");
  expect(result.sandbox).toMatchObject({ mode, backend: process.platform === "win32" ? "windows-acl" : "seatbelt" });
}, 30_000);

const macNativeTest = process.platform === "darwin" ? test : test.skip;
macNativeTest("business-only Seatbelt boundary writes Python state but not Bun or unrelated state", async () => {
  const { root, workspace, policy, paths } = fixture();
  const [pythonState, pythonDb, logs] = paths.managedPythonStateRoots();
  for (const directory of [pythonState!, pythonDb!, logs!, join(root, "outside")]) mkdirSync(directory, { recursive: true });
  const bunDatabase = join(root, "var", "db", "agent.sqlite3");
  const execState = join(root, "var", "db", "exec-sessions", "outside.txt");
  mkdirSync(join(root, "var", "db", "exec-sessions"), { recursive: true });
  writeFileSync(bunDatabase, "bun-state");
  const outside = join(root, "outside", "outside.txt");
  const script = join(workspace, "managed-state-probe.py");
  writeFileSync(script, `import json\nfrom pathlib import Path\nitems = ${JSON.stringify({
    state: join(pythonState!, "probe.txt"),
    database: join(pythonDb!, "probe.txt"),
    logs: join(logs!, "probe.txt"),
    bun: bunDatabase,
    execState,
    outside,
  })}\nresult = {}\nfor name, raw in items.items():\n    try:\n        Path(raw).write_text('changed', encoding='utf-8')\n        result[name] = True\n    except OSError:\n        result[name] = False\nprint(json.dumps(result, sort_keys=True))\n`);
  const python = join(process.cwd(), ".venv", "bin", "python");
  const command = `${quote(python)} -I -B ${quote(script)}`;
  const managerWithStateRoot = manager(paths);
  try {
    const business = await execute(managerWithStateRoot, policy("workspace-write"), command, workspace, 10_000,
      executionBoundary(policy("workspace-write"), paths, true));
    expect(business.status, JSON.stringify(business)).toBe("completed");
    expect(String(business.output)).toContain('"state": true');
    expect(String(business.output)).toContain('"database": true');
    expect(String(business.output)).toContain('"logs": true');
    expect(String(business.output)).toContain('"bun": false');
    expect(String(business.output)).toContain('"execState": false');
    expect(String(business.output)).toContain('"outside": false');
    expect(readFileSync(bunDatabase, "utf8")).toBe("bun-state");

    const ordinary = await execute(managerWithStateRoot, policy("workspace-write"), command, workspace);
    expect(ordinary.status, JSON.stringify(ordinary)).toBe("completed");
    expect(String(ordinary.output)).toContain('"state": false');
    expect(String(ordinary.output)).toContain('"database": false');
    expect(String(ordinary.output)).toContain('"logs": false');
    expect(readFileSync(bunDatabase, "utf8")).toBe("bun-state");
  } finally {
    await managerWithStateRoot.stop();
  }
}, 30_000);

nativeTest("native sandbox blocks junction/symlink targets outside the workspace", async () => {
  const { root, workspace, policy } = fixture();
  const outside = join(root, "outside"); mkdirSync(outside);
  writeFileSync(join(outside, "file"), "original");
  symlinkSync(outside, join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
  const script = join(workspace, "link.cjs");
  writeFileSync(script, `console.log('before-link-write'); require('node:fs').writeFileSync(${JSON.stringify(join(workspace, "link", "file"))}, 'escaped')`);
  const result = await execute(manager(), policy("workspace-write"), invokeNode(script));
  expect(result.status).toBe("failed");
  expect(String(result.output)).toContain("before-link-write");
  expect(readFileSync(join(outside, "file"), "utf8")).toBe("original");
}, 30_000);

nativeTest("simultaneous workspaces use their own policies and cannot write each other's files", async () => {
  const a = fixture(), b = fixture();
  const script = join(a.root, "parallel.cjs");
  writeFileSync(script, `const fs=require('node:fs'); const own=process.env.LXE_WORKSPACE_ROOT; fs.writeFileSync(require('node:path').join(own, 'own'), 'ok');
    const other=own===${JSON.stringify(a.workspace)}?${JSON.stringify(b.workspace)}:${JSON.stringify(a.workspace)};
    try { fs.writeFileSync(require('node:path').join(other, 'escaped'), 'bad'); process.exit(20); } catch(e) { console.log(e.code); }`);
  const m = manager();
  const results = await Promise.all([a,b].map(f => execute(m, f.policy("workspace-write"), invokeNode(script))));
  for (const r of results) expect(r.status).toBe("completed");
  for (const f of [a,b]) { expect(existsSync(join(f.workspace, "own"))).toBe(true); expect(existsSync(join(f.workspace, "escaped"))).toBe(false); }
}, 30_000);

nativeTest("wait preserves output and cancellation kills a running descendant", async () => {
  const { workspace, policy } = fixture();
  const script = join(workspace, "parent.cjs"), child = join(workspace, "child.cjs");
  const heartbeat = join(workspace, "heartbeat");
  writeFileSync(child, `setInterval(()=>require('node:fs').writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 50);`);
  writeFileSync(script, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(child)}], {stdio:'inherit'}); console.log('started'); setInterval(()=>{},1000);`);
  const p = policy("workspace-write"), m = manager();
  const first = await execute(m, p, invokeNode(script), workspace, 250);
  expect(first.status).toBe("running");
  const deadline = Date.now() + 15_000;
  while (!existsSync(heartbeat) && Date.now() < deadline) await Bun.sleep(50);
  expect(existsSync(heartbeat)).toBe(true);
  const stopped = await m.wait({ execId: String(first.exec_id), sessionId: p.sessionId, yieldMs: 1_000, terminate: true, signal: new AbortController().signal });
  expect(stopped.status).toBe("killed");
  const after = readFileSync(heartbeat, "utf8");
  await Bun.sleep(250);
  expect(readFileSync(heartbeat, "utf8")).toBe(after);
}, 30_000);

nativeTest("standing workspace grants do not authorize a later read-only command; full access still works", async () => {
  const { root, workspace, policy } = fixture();
  const outside = join(root, "outside"), inside = join(workspace, "inside");
  writeFileSync(outside, "keep");
  const script = join(workspace, "modes.cjs");
  writeFileSync(script, `const fs=require('node:fs'); console.log('entered'); fs.writeFileSync(${JSON.stringify(inside)}, 'inside'); fs.writeFileSync(${JSON.stringify(outside)}, 'outside');`);
  const m = manager();
  const write = await execute(m, policy("workspace-write"), invokeNode(script));
  expect(String(write.output)).toContain("entered");
  expect(write.status).toBe("failed");
  expect(readFileSync(inside, "utf8")).toBe("inside");
  expect(readFileSync(outside, "utf8")).toBe("keep");
  writeFileSync(inside, "readonly-marker");
  const read = await execute(m, policy("read-only"), invokeNode(script));
  expect(String(read.output)).toContain("entered");
  expect(read.status).toBe("failed");
  expect(readFileSync(inside, "utf8")).toBe("readonly-marker");
  const full = await execute(m, policy("danger-full-access"), invokeNode(script));
  expect(full.status, JSON.stringify(full)).toBe("completed");
  expect(readFileSync(outside, "utf8")).toBe("outside");
}, 30_000);

nativeTest("native policy prevents deleting and renaming outside files, and host output can still spill", async () => {
  const { root, workspace, policy } = fixture();
  const outside = join(root, "outside"); writeFileSync(outside, "keep");
  const script = join(workspace, "mutations.cjs");
  writeFileSync(script, `const fs=require('node:fs');
    for(const [name, fn] of [['delete',()=>fs.unlinkSync(${JSON.stringify(outside)})], ['rename',()=>fs.renameSync(${JSON.stringify(outside)}, ${JSON.stringify(join(workspace, "stolen"))})]]) {
      try { fn(); console.log(name+':allowed'); } catch(e) { console.log(name+':denied '+e.code); }
    } console.log('x'.repeat(200000));`);
  const p = policy("workspace-write"), m = manager();
  const result = await execute(m, p, invokeNode(script));
  expect(result.status, JSON.stringify(result)).toBe("completed");
  const saved = await m.ensureOutputFile(String(result.exec_id), p.sessionId);
  expect(saved.output_file_error).toBeUndefined();
  const snapshot = m.snapshots()[0]!;
  const output = readFileSync(String(snapshot.output_path), "utf8");
  expect(output).toContain("delete:denied");
  expect(output).toContain("rename:denied");
  expect(readFileSync(outside, "utf8")).toBe("keep");
  expect(existsSync(join(workspace, "stolen"))).toBe(false);
}, 30_000);

nativeTest("parallel commands in one workspace keep their temporary directories usable", async () => {
  const { workspace, policy } = fixture();
  const script = join(workspace, "temps.cjs");
  writeFileSync(script, `const fs=require('node:fs'), path=require('node:path');
    const file=path.join(process.env.TMPDIR, process.env.LXE_EXEC_SESSION_ID); fs.writeFileSync(file, 'before');
    setTimeout(()=>{ fs.writeFileSync(file, 'after'); fs.unlinkSync(file); console.log('temp-ok:'+process.env.TMPDIR); }, 250);`);
  const m = manager();
  const results = await Promise.all(["one", "two"].map(id => execute(m, policy("workspace-write", id), invokeNode(script))));
  for (const result of results) { expect(result.status, JSON.stringify(result)).toBe("completed"); expect(String(result.output)).toContain("temp-ok:"); }
  if (process.platform === "win32") expect(results[0]!.output).not.toBe(results[1]!.output);
  else expect(results[0]!.output).toBe(results[1]!.output);
  if (process.platform === "win32") {
    for (const result of results) {
      const temporary = String(result.output).match(/temp-ok:([^\r\n]+)/u)?.[1];
      expect(temporary).toBeTruthy();
      expect(existsSync(temporary!)).toBe(true);
    }
    const same = policy("workspace-write", "shared");
    const overlap = await Promise.all([1,2].map(() => execute(m, same, invokeNode(script))));
    for (const result of overlap) expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(overlap[0]!.output).toBe(overlap[1]!.output);
    await m.stop();
    for (const result of [...results, ...overlap]) expect(existsSync(String(result.output).match(/temp-ok:([^\r\n]+)/u)![1]!)).toBe(false);
  }
}, 30_000);

nativeTest("project Python writes artifacts and private temp but cannot write the host output directory", async () => {
  const { workspace, policy, paths } = fixture();
  const p = policy("workspace-write");
  mkdirSync(paths.outputDirectory(p), { recursive: true });
  const script = join(workspace, "probe.py");
  writeFileSync(script, `import os\nfrom pathlib import Path\nroot = Path(os.environ['LXE_WORKSPACE_ROOT']) / '.lxeagent' / 'artifacts'\nroot.mkdir(parents=True, exist_ok=True)\n(root / 'python.txt').write_text('artifact')\ntemporary = Path(os.environ['TMPDIR'], 'lxe-python-%s.tmp' % os.getpid())\ntemporary.write_text('temporary')\ntemporary.unlink()\ntry:\n    Path(${JSON.stringify(join(paths.outputDirectory(p), "escaped"))}).write_text('bad')\nexcept PermissionError as error:\n    print('host-output-denied:', error)\nelse:\n    raise RuntimeError('host output writable')\nprint('python-ok')\n`);
  const python = join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const result = await execute(manager(paths), p, `${process.platform === "win32" ? "& " : ""}${quote(python)} -I -B ${quote(script)}`);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(String(result.output)).toContain("host-output-denied:");
  expect(String(result.output)).toContain("python-ok");
  expect(readFileSync(join(paths.artifactRoot(p), "python.txt"), "utf8")).toBe("artifact");
  expect(existsSync(join(paths.outputDirectory(p), "escaped"))).toBe(false);
}, 30_000);

macNativeTest("registered business CLI bootstrap needs no full-access approval and makes no ERP request", async () => {
  const { workspace, policy, paths } = fixture();
  const dataRoot = paths.dataRoot;
  // Match trusted Desktop startup; no private input or configuration write grant.
  for (const directory of ["inputs", "logs", "lxeskill", "db/lxeskill"]) mkdirSync(join(dataRoot, directory), { recursive: true });
  const approvals = new PermissionApprovalService({ changed() {}, audit: async () => {} });
  const catalog = loadLxeSkillCommandCatalog(join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json"));
  const registry = new ToolRegistry();
  const processes = registerCodingTools(registry, {
    executionPaths: new ExecutionPaths(dataRoot, { temporaryRoot: join(dataRoot, "tmp") }),
    approvals,
    businessCommandCatalog: catalog,
    execShell: new ExecShellAdapter({ environment: { ...process.env, LXE_DATA_ROOT: dataRoot, LOCAL_LOGS_ENABLED: "1", LXE_SQLITE_DB_PATH: join(dataRoot, "db/lxeskill/lxeskill.sqlite3") } }),
  });
  managers.push(processes);
  const context = { session_id: policy("workspace-write").sessionId, turn_id: "turn", tool_call_id: "cli", platform: "desktop",
    executionPolicy: policy("workspace-write"), workspace: workspaceFor(workspace, process.cwd()),
    handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} } };
  try {
    for (const command of ["lxeskill yacang export run", "lxeskill mabang-tms export run", "lxeskill mabang brazil-overseas export run", "lxeskill shangman export run", "lxeskill shangman login prepare", "lxeskill shangman login submit"]) {
      expect(catalog.some(entry => entry.command === command && entry.visibility === "business"), command).toBe(true);
      // This unknown flag is rejected before handler dispatch: real CLI bootstrap,
      // zero network/exporter requests, no mocked sandbox or approval service.
      const result = await registry.execute("exec", { command: `${command} --sandbox-probe-invalid-option`, "yield-time-ms": 10000 }, context);
      const output = String(result.content[0]?.text);
      expect(output, command).toContain("code: invalid_arguments");
      expect(output).not.toMatch(/PermissionError|Operation not permitted|migration_failed/);
      expect(approvals.snapshot()).toEqual([]);
    }
    expect(existsSync(join(dataRoot, "logs/runtime"))).toBe(true);
  } finally { await approvals.stop(); }
}, 30000);

nativeTest("unregistered CLI preserves its outside-state error and needs explicit full-access approval", async () => {
  const { root, workspace, policy, paths } = fixture();
  const dataRoot = join(root, "cli-state");
  const approvals = new PermissionApprovalService({ changed() {}, audit: async () => {} });
  const registry = new ToolRegistry();
  const processes = registerCodingTools(registry, { executionPaths: paths, approvals,
    execShell: new ExecShellAdapter({ environment: { ...process.env, LXE_DATA_ROOT: dataRoot, LOCAL_LOGS_ENABLED: "0", PYTHONDONTWRITEBYTECODE: "1" } }) });
  managers.push(processes);
  const context = { session_id: policy("workspace-write").sessionId, turn_id: "turn", tool_call_id: "cli", platform: "desktop",
    executionPolicy: policy("workspace-write"), workspace: workspaceFor(workspace, process.cwd()),
    handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} } };
  try {
    const denied = await registry.execute("exec", { command: "lxeskill list", "yield-time-ms": 10000 }, context);
    const output = String(denied.content[0]?.text);
    expect(output).toContain("status: failed");
    expect(output).toMatch(/PermissionError|EACCES|Operation not permitted|Access is denied/i);
    expect(existsSync(join(dataRoot, "lxeskill"))).toBe(false);
    const call = registry.execute("exec", { command: "lxeskill list", "yield-time-ms": 10000, sandbox_permissions: "danger-full-access", justification: "Initialize the requested CLI state" }, context);
    const deadline = Date.now() + 2000;
    while (!approvals.snapshot().length && Date.now() < deadline) await Bun.sleep(1);
    const request = approvals.snapshot()[0]!;
    expect(request.tool).toBe("exec"); expect(existsSync(join(dataRoot, "lxeskill"))).toBe(false);
    await approvals.decide({ session_id: context.session_id, request_id: request.request_id, decision: "allow" });
    const allowed = await call;
    expect(String(allowed.content[0]?.text)).toContain("status: completed");
    expect(existsSync(join(dataRoot, "lxeskill"))).toBe(true);
  } finally { await approvals.stop(); }
}, 30000);
