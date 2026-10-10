import { ExecShellAdapter } from "../../src/tooling/exec-shell";
import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, PermissionMode } from "@lxe/protocol";
import { PermissionApprovalService, requestedPolicy } from "../../src/permissions/approvals";
import { ExecutionPaths } from "../../src/permissions/execution-paths";
import { PermissionPolicyService } from "../../src/permissions/policy";
import { registerCodingTools } from "../../src/tooling/coding/register";
import { ToolRegistry } from "../../src/tooling/registry";
import { workspaceFor } from "../workspace";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture(channel = "desktop", businessCommandCatalog: readonly { command: string; ownerSkills: readonly string[] }[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lxe-approval-"))), directory = join(root, "workspace");
  mkdirSync(directory);
  const workspace = workspaceFor(directory), policyService = new PermissionPolicyService();
  const events: JsonObject[] = [], changes: string[] = [];
  const approvals = new PermissionApprovalService({ changed: id => { changes.push(id); }, audit: async (_id, event) => { events.push(event); } });
  const tools = new ToolRegistry();
  const paths = new ExecutionPaths(join(root, "var"), { platform: "win32", temporaryRoot: join(root, "temp") });
  const processes = registerCodingTools(tools, { approvals, executionPaths: paths, businessCommandCatalog,
    execShell: new ExecShellAdapter({ environment: { ...process.env,
      LXE_MANAGED_PYTHON: join(process.cwd(), process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"),
      LXE_DATA_ROOT: join(root, "var"), LXE_SQLITE_DB_PATH: join(root, "var/db/lxeskill.sqlite3"),
    } }),
  });
  const controller = new AbortController();
  const context = (mode: PermissionMode = "read-only", id = "s", call = "call") => ({
    executionPolicy: policyService.resolve({ session_id: id, workspace, permission_mode: mode }),
    session_id: id, turn_id: "turn", tool_call_id: call, platform: channel, workspace,
    handle: { signal: controller.signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} },
  });
  cleanup.push(async () => { await approvals.stop(); await processes.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, directory, approvals, events, changes, tools, context, controller };
}
const elevated = { sandbox_permissions: "workspace-write", justification: "Save the requested report" };
async function pending(service: PermissionApprovalService, count = 1) {
  const deadline = Date.now() + 2000;
  while (service.snapshot().length !== count && Date.now() < deadline) await Bun.sleep(1);
  expect(service.snapshot()).toHaveLength(count);
  return service.snapshot();
}

test("approval arguments are paired in all modes, cannot downgrade, and repeated modes need no approval", () => {
  const base = { mode: "workspace-write" as const, workspaceRoot: "/work", sessionId: "s" };
  for (const input of [{ sandbox_permissions: "danger-full-access" }, { justification: "because" }, { ...elevated, justification: " " }, { ...elevated, sandbox_permissions: "read-only" }]) {
    expect(() => requestedPolicy(input, base)).toThrow();
  }
  expect(requestedPolicy(elevated, base)).toBe(base);
  expect(() => requestedPolicy(elevated, { ...base, mode: "danger-full-access" })).toThrow("reduce");
  expect(requestedPolicy({ ...elevated, sandbox_permissions: "danger-full-access" }, base).mode).toBe("danger-full-access");
});

test("freezes the original write, accepts only the matching decision once and leaves the session policy unchanged", async () => {
  const f = fixture(), context = f.context(), input = { file_path: "nested/file", content: "original request", ...elevated };
  const call = f.tools.execute("write", input, context);
  const [request] = await pending(f.approvals);
  expect(existsSync(join(f.directory, "nested"))).toBe(false);
  input.content = "changed by caller";
  request!.arguments.content = "changed by client";
  expect(f.approvals.snapshot()[0]!.arguments.content).toBe("original request");
  expect(() => f.approvals.decide({ session_id: "other", request_id: request!.request_id, decision: "allow" })).toThrow();
  const decision = { session_id: "s", request_id: request!.request_id, decision: "allow" as const };
  const a = f.approvals.decide(decision), b = f.approvals.decide(decision);
  expect(a).toBe(b); await a; await call;
  expect(readFileSync(join(f.directory, "nested/file"), "utf8")).toBe("original request");
  expect(context.executionPolicy.mode).toBe("read-only");
  expect(() => f.approvals.decide({ ...decision, decision: "deny" })).toThrow("different decision");
  expect(f.events.map(event => event.decision)).toEqual(["requested", "allow"]);
});

test("concurrent calls keep independent approvals; mode changes do not remove old requests", async () => {
  const f = fixture();
  const first = f.tools.execute("write", { file_path: "one", content: "one", ...elevated }, f.context("read-only", "s", "one"));
  const second = f.tools.execute("write", { file_path: "two", content: "two", ...elevated }, f.context("read-only", "s", "two")).catch(error => error);
  const requests = await pending(f.approvals, 2);
  await f.tools.execute("write", { file_path: "full", content: "full" }, f.context("danger-full-access"));
  expect(f.approvals.snapshot()).toHaveLength(2);
  await f.approvals.decide({ session_id: "s", request_id: requests[1]!.request_id, decision: "deny" });
  expect((await second).code).toBe("permission_denied");
  await f.approvals.decide({ session_id: "s", request_id: requests[0]!.request_id, decision: "allow" });
  await first;
  expect(existsSync(join(f.directory, "two"))).toBe(false);
});

test.each(["write", "edit"] as const)("%s approval refuses a target changed while waiting even if another call updates the ledger", async tool => {
  const f = fixture(), path = join(f.directory, "file"); writeFileSync(path, "before");
  await f.tools.execute("read", { path }, f.context());
  const input = tool === "write" ? { file_path: path, content: "after", ...elevated } : { path, edits: [{ oldText: "before", newText: "after" }], ...elevated };
  const call = f.tools.execute(tool, input, f.context()).catch(error => error);
  const [request] = await pending(f.approvals);
  await f.tools.execute("write", { file_path: path, content: "external" }, f.context("danger-full-access"));
  await f.approvals.decide({ session_id: "s", request_id: request!.request_id, decision: "allow" });
  expect((await call).message).toMatch(/changed|重新 read/);
  expect(readFileSync(path, "utf8")).toBe("external");
});

test.each(["hardlink", "symlink", "appeared", "removed"] as const)("approval rechecks target identity and existence: %s", async change => {
  const f = fixture(), path = join(f.directory, "file"), other = join(f.directory, "other");
  if (change !== "appeared") writeFileSync(path, "before");
  writeFileSync(other, "other");
  if (change !== "appeared") await f.tools.execute("read", { path }, f.context());
  const call = f.tools.execute("write", { file_path: path, content: "after", ...elevated }, f.context()).catch(error => error);
  const [request] = await pending(f.approvals);
  if (change === "hardlink") linkSync(path, join(f.root, "hardlink"));
  if (change === "symlink") { unlinkSync(path); symlinkSync(other, path, "file"); }
  if (change === "appeared") writeFileSync(path, "appeared");
  if (change === "removed") unlinkSync(path);
  await f.approvals.decide({ session_id: "s", request_id: request!.request_id, decision: "allow" });
  expect(await call).toBeInstanceOf(Error);
  expect(readFileSync(other, "utf8")).toBe("other");
  if (existsSync(path)) expect(readFileSync(path, "utf8")).not.toBe("after");
});

test.each(["cancel", "delete", "shutdown"] as const)("%s expires pending authority without creating a target", async action => {
  const f = fixture();
  const call = f.tools.execute("write", { file_path: "new/file", content: "after", ...elevated }, f.context()).catch(error => error);
  const [request] = await pending(f.approvals);
  if (action === "cancel") f.controller.abort();
  if (action === "delete") await f.approvals.forgetSession("s");
  if (action === "shutdown") await f.approvals.stop();
  expect(await call).toBeInstanceOf(Error);
  expect(existsSync(join(f.directory, "new"))).toBe(false);
  expect(() => f.approvals.decide({ session_id: "s", request_id: request!.request_id, decision: "allow" })).toThrow();
  expect(f.events.at(-1)?.decision).toBe("cancelled");
  const restarted = new PermissionApprovalService({ changed() {}, audit: async () => {} });
  expect(() => restarted.decide({ session_id: "s", request_id: request!.request_id, decision: "allow" })).toThrow("restarted");
});

test("non-desktop channels fail instead of waiting; matching permission needs no approval channel", async () => {
  const f = fixture("feishu");
  await expect(f.tools.execute("write", { file_path: "new/file", content: "after", ...elevated }, f.context())).rejects.toThrow("unavailable on this channel");
  expect(f.approvals.snapshot()).toEqual([]);
  expect(existsSync(join(f.directory, "new"))).toBe(false);
  await f.tools.execute("write", { file_path: "same", content: "after", ...elevated }, f.context("workspace-write"));
  expect(readFileSync(join(f.directory, "same"), "utf8")).toBe("after");
});

test("exec waits without spawning, then only its approved call uses full access", async () => {
  const f = fixture(), path = join(f.root, "exec-created");
  const command = process.platform === "win32" ? `Set-Content -LiteralPath '${path.replaceAll("'", "''")}' -Value 'allowed'` : `printf allowed > '${path.replaceAll("'", `'"'"'`)}'`;
  const context = f.context();
  const call = f.tools.execute("exec", { command, "yield-time-ms": 10000, sandbox_permissions: "danger-full-access", justification: "Create the explicit outside file" }, context);
  const [request] = await pending(f.approvals);
  expect(existsSync(path)).toBe(false);
  expect(request!.preview).toEqual({ command, cwd: f.directory });
  await f.approvals.decide({ session_id: "s", request_id: request!.request_id, decision: "allow" });
  const result = await call;
  expect(String(result.content[0]!.text)).toContain("status: completed");
  expect(readFileSync(path, "utf8").trim()).toBe("allowed");
  expect(context.executionPolicy.mode).toBe("read-only");
}, 15000);

test("a failed audit write cannot release executable authority", async () => {
  const f = fixture();
  const service = new PermissionApprovalService({ changed() {}, audit: async (_id, event) => { if (event.decision === "allow") throw new Error("ENOSPC: audit fixture"); } });
  const context = f.context(), input = { ...elevated, content: "report" };
  const call = service.request("write", input, context, requestedPolicy(input, context.executionPolicy), { path: "file", content: "report" }).catch(error => error);
  const [request] = await pending(service);
  await expect(service.decide({ session_id: "s", request_id: request!.request_id, decision: "allow" })).rejects.toThrow("ENOSPC");
  expect((await call).message).toContain("ENOSPC");
  expect(service.snapshot()).toEqual([]);
});


test("Vietnam exec requests ordinary one-shot approval and respects denial", async () => {
  const f = fixture("desktop", [{ command: "lxeskill vietnam replenishment calculate", ownerSkills: ["vietnam-replenishment"] }]);
  const context = f.context("workspace-write");
  const execution = f.tools.execute("exec", { command: "lxeskill vietnam replenishment calculate", sandbox_permissions: "danger-full-access", justification: "Write the app-owned ERP task records" }, context).catch(error => error);
  const [request] = await pending(f.approvals);
  expect(request!.tool).toBe("exec");
  await f.approvals.decide({ session_id: "s", request_id: request!.request_id, decision: "deny" });
  expect((await execution).code).toBe("permission_denied");
  expect(context.executionPolicy.mode).toBe("workspace-write");
});

test("approved Vietnam exec uses the ordinary CLI and leaves the session permission unchanged", async () => {
  const f = fixture("desktop", [{ command: "lxeskill vietnam replenishment calculate", ownerSkills: ["vietnam-replenishment"] }]);
  const context = f.context("workspace-write");
  const execution = f.tools.execute("exec", { command: "lxeskill vietnam replenishment calculate --help", sandbox_permissions: "danger-full-access", justification: "Read the command contract" }, context);
  const [request] = await pending(f.approvals);
  await f.approvals.decide({ session_id: "s", request_id: request!.request_id, decision: "allow" });
  const result = await execution;
  expect(JSON.stringify(result.content)).toContain("sku_map");
  expect(context.executionPolicy.mode).toBe("workspace-write");
});
