import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionPaths } from "../../src/permissions/execution-paths";
import { ExecSandbox } from "../../src/permissions/exec-sandbox";
import { CodingProcessManager } from "../../src/tooling/coding/process-manager";
import { ExecShellAdapter } from "../../src/tooling/exec-shell";
import type { ExecutionPolicy } from "../../src/permissions/policy";
import { workspaceFor } from "../workspace";
import { managedStateWriteSid, tempWriteSid, workspaceWriteSid } from "../../native/windows-sandbox/acl/workspace-sid";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
function fixture(fail = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lxe-session-temp-"))); roots.push(root);
  const workspace = join(root, "workspace"), temporaryRoot = join(root, "temp"), dataRoot = join(root, "var"); mkdirSync(workspace); mkdirSync(temporaryRoot);
  const runner = join(root, "helper.cjs"), log = join(root, "helper.log");
  const stateSid = managedStateWriteSid(dataRoot);
  writeFileSync(runner, `const fs=require('node:fs'); const action=process.argv[2]; fs.appendFileSync(${JSON.stringify(log)},action+'\\n');
    if(action==='--prepare-session') { if(${fail}) { console.error('fixture Win32 5'); process.exit(5); } console.log(JSON.stringify({writeSid:'workspace-fixture',tempWriteSid:'temp-fixture',managedStateWriteSid:${JSON.stringify(stateSid)}})); }`);
  const paths = new ExecutionPaths(dataRoot, { platform: "win32", temporaryRoot });
  const sandbox = new ExecSandbox({ paths, environment: { LXE_EXEC_SANDBOX_NODE: process.execPath, LXE_EXEC_SANDBOX_RUNNER: runner } });
  const policy: ExecutionPolicy = Object.freeze({ mode: "workspace-write", workspaceRoot: workspace, sessionId: "s" });
  return { root, workspace, temporaryRoot, sandbox, paths, policy, log, stateSid };
}
const command = { argv: ["unused"], detached: false };

test("managed-state capability has a separate deterministic Windows SID", () => {
  const workspace = "C:\\LXE\\workspace", dataRoot = "C:\\Users\\test\\LXE Agent\\var", temporary = "C:\\Temp\\lxe-private";
  const stateSid = managedStateWriteSid(dataRoot);
  expect(stateSid).toBe(managedStateWriteSid(dataRoot));
  expect(stateSid).not.toBe(workspaceWriteSid(workspace));
  expect(stateSid).not.toBe(tempWriteSid(temporary));
});

test("concurrent Windows preparation shares one grant; sessions and restarts are isolated; command completion and mode changes retain grants", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.sandbox.prepare(f.policy, command), f.sandbox.prepare(f.policy, command)]);
  expect(a.argv).toEqual(b.argv);
  expect(readFileSync(f.log, "utf8")).toBe("--prepare-session\n");
  expect(a.argv).toContain("--write-sid"); expect(a.argv).toContain("--temp-write-sid");
  expect(a.argv).not.toContain("--state-write-sid");
  const businessBoundary = f.sandbox.boundary(f.policy, true);
  const business = await f.sandbox.prepare(f.policy, command, businessBoundary);
  expect(business.argv).toContain("--state-write-sid");
  expect(business.argv).toContain(f.stateSid);
  expect(business.argv).toContain("--data-root");
  expect(business.argv).toContain(f.paths.dataRoot);
  expect(existsSync(a.temporaryDirectory)).toBe(true);
  await f.sandbox.prepare({ ...f.policy, mode: "read-only" }, command);
  await f.sandbox.prepare({ ...f.policy, mode: "danger-full-access" }, command);
  expect(readFileSync(f.log, "utf8")).toBe("--prepare-session\n");
  const c = await f.sandbox.prepare({ ...f.policy, sessionId: "other" }, command);
  expect(c.temporaryDirectory).not.toBe(a.temporaryDirectory);
  expect(new ExecutionPaths(f.paths.dataRoot, { platform: "win32", temporaryRoot: f.temporaryRoot }).temporaryDirectory(f.policy)).not.toBe(a.temporaryDirectory);
  await f.sandbox.releaseSession("s");
  expect(existsSync(a.temporaryDirectory)).toBe(false); expect(existsSync(c.temporaryDirectory)).toBe(true);
  await f.sandbox.stop(); expect(existsSync(c.temporaryDirectory)).toBe(false);
});

test("failed preparation reports the actual error, releases its grant and removes only its temporary directory", async () => {
  const f = fixture(true);
  await expect(f.sandbox.prepare(f.policy, command)).rejects.toThrow("fixture Win32 5");
  expect(existsSync(f.paths.temporaryDirectory(f.policy))).toBe(false);
  expect(existsSync(f.workspace)).toBe(true);
  expect(readFileSync(f.log, "utf8")).toBe("--prepare-session\n--release-session\n");
  await f.sandbox.stop();
});

test("admission rechecks a replaced workspace before any directory creation or authorization", async () => {
  const f = fixture(), link = join(f.root, "alias"), other = join(f.root, "other"); mkdirSync(other);
  symlinkSync(f.workspace, link, process.platform === "win32" ? "junction" : "dir");
  const policy = { ...f.policy, workspaceRoot: link };
  const manager = new CodingProcessManager({ maxOutputBytes: 2000, tailBytes: 1000, shell: new ExecShellAdapter(), sandbox: f.sandbox });
  const internals = manager as unknown as { enforceCapacity(id: string): Promise<void> };
  const hook = spyOn(internals, "enforceCapacity").mockImplementationOnce(async () => {
    rmSync(link, { recursive: true }); symlinkSync(other, link, process.platform === "win32" ? "junction" : "dir");
  });
  try {
    const result = await manager.execute({ executionPolicy: policy, command: "echo no", cwd: f.workspace, sessionId: "s", workspace: workspaceFor(link), responseRouteId: "", toolCallId: "call", signal: new AbortController().signal, yieldMs: 1000 });
    expect(String(result.error)).toContain("boundary changed");
    expect(existsSync(f.log)).toBe(false);
    expect(existsSync(f.paths.temporaryDirectory(policy))).toBe(false);
  } finally { hook.mockRestore(); await manager.stop(); }
});

test("cancellation during asynchronous preparation never spawns the command; runtime close releases prepared resources", async () => {
  const f = fixture(), controller = new AbortController();
  const prepare = f.sandbox.prepare.bind(f.sandbox);
  const hook = spyOn(f.sandbox, "prepare").mockImplementation(async (...args) => {
    const result = await prepare(...args); controller.abort(new Error("cancel after grant")); return result;
  });
  const manager = new CodingProcessManager({ maxOutputBytes: 2000, tailBytes: 1000, shell: new ExecShellAdapter(), sandbox: f.sandbox });
  const result = await manager.execute({ executionPolicy: f.policy, command: "echo no", cwd: f.workspace, sessionId: "s", workspace: workspaceFor(f.workspace), responseRouteId: "", toolCallId: "call", signal: controller.signal, yieldMs: 1000 });
  expect(String(result.error)).toContain("cancel after grant"); expect(manager.snapshots()).toEqual([]);
  expect(existsSync(f.paths.temporaryDirectory(f.policy))).toBe(true);
  hook.mockRestore(); await manager.stop();
  expect(existsSync(f.paths.temporaryDirectory(f.policy))).toBe(false);
});

test("Windows session teardown also cleans temporary files created by file tools without exec grants", async () => {
  const f = fixture(), directory = f.paths.temporaryDirectory(f.policy);
  mkdirSync(directory); writeFileSync(join(directory, "file-tool-output"), "temporary");
  await f.sandbox.stop();
  expect(existsSync(directory)).toBe(false);
  expect(existsSync(f.log)).toBe(false);
});
