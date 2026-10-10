import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OneShotCliRunner, PermissionApprovalService, PermissionPolicyService, SqliteRuntimeStore, ToolRegistry, registerCodingTools, type ToolDefinition } from "@lxe/runtime";
import { DashboardService } from "../src/dashboard-service";
import { repositoryRoot } from "@lxe/core";
import { CodingProcessManager } from "../../../packages/agent/runtime/src/tooling/coding/process-manager";
import { createAgentRuntimeHost } from "../src/runtime-host";

test("dashboard mode and approval RPCs persist audit data, preserve pending targets and never restore executable approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-permission-rpc-")), directory = join(root, "workspace"), db = join(root, "agent.sqlite3");
  mkdirSync(directory);
  let store = new SqliteRuntimeStore(db);
  await store.start();
  const workspace = { directory, worktree: directory };
  const events: string[] = [];
  const approvals = new PermissionApprovalService({ changed: id => { events.push(id); }, audit: (id, event) => store.appendApprovalEvent(id, event) });
  const tools = new ToolRegistry(), processes = registerCodingTools(tools, { approvals });
  const service = new DashboardService({ stateRoot: root, llmConfigRoot: root, skillsRoot: root, userSkillsRoot: root,
    environment: {}, store, tools, approvals, mcpConfig: { servers: [] }, onPermissionChanged: id => { events.push(`mode:${id}`); } });
  try {
    const blank = await service.call({ operation: "sessions.create", input: { directory } });
    expect(blank.permission_mode).toBe("workspace-write");
    const id = blank.session_id;
    await service.call({ operation: "sessions.permission.set", input: { session_id: id, permission_mode: "read-only" } });
    expect((await service.call({ operation: "sessions.create", input: { directory } })).permission_mode).toBe("read-only");
    const context = { session_id: id, turn_id: "turn", tool_call_id: "call", platform: "desktop", workspace,
      executionPolicy: new PermissionPolicyService().resolve((await store.getSession(id))!),
      handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} } };
    const call = tools.execute("write", { file_path: "file", content: "approved", sandbox_permissions: "workspace-write", justification: "Save report" }, context);
    const deadline = Date.now() + 2000;
    while (!approvals.snapshot().length && Date.now() < deadline) await Bun.sleep(1);
    const request = (await service.call({ operation: "sessions.approvals", input: {} })).items[0]!;
    expect(request.target_mode).toBe("workspace-write");
    await service.call({ operation: "sessions.permission.set", input: { session_id: id, permission_mode: "danger-full-access" } });
    expect((await service.call({ operation: "sessions.approvals", input: {} })).items[0]?.request_id).toBe(request.request_id);
    await service.call({ operation: "sessions.approval.decide", input: { session_id: id, request_id: request.request_id, decision: "allow" } });
    await call;
    expect(readFileSync(join(directory, "file"), "utf8")).toBe("approved");
    expect((await service.call({ operation: "sessions.detail", input: { session_id: id } })).session.permission_mode).toBe("danger-full-access");
    const transcript = readFileSync(join(root, "session_transcripts", `${id}.jsonl`), "utf8");
    expect(transcript).toContain('"decision":"requested"'); expect(transcript).toContain('"decision":"allow"');
    expect(await store.loadMessages(id)).toEqual([]);
    await approvals.stop(); await store.stop();
    store = new SqliteRuntimeStore(db); await store.start();
    expect((await store.getSession(id))?.permission_mode).toBe("danger-full-access");
    expect(await store.loadMessages(id)).toEqual([]);
    const restarted = new PermissionApprovalService({ changed() {}, audit: async () => {} });
    expect(restarted.snapshot()).toEqual([]);
    expect(() => restarted.decide({ session_id: id, request_id: request.request_id, decision: "allow" })).toThrow();
    expect(events).toContain(`mode:${id}`);
  } finally { await approvals.stop(); await processes.stop(); await store.stop(); service.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("host shutdown still stops processes and releases resources when approval audit cleanup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-permission-shutdown-"));
  const skills = join(root, "skills"), soul = join(root, "SOUL.md");
  mkdirSync(skills); writeFileSync(soul, "Test instructions");
  const host = createAgentRuntimeHost({
    dataRoot: root, legacyWorkspace: { directory: root, worktree: root },
    agentSoulPath: soul, skillsRoot: skills, userSkillsRoot: join(root, "user"),
    llmConfigRoot: join(repositoryRoot(import.meta.dir), "config", "llm"),
    lxeskillCatalogPath: join(root, "missing-catalog.json"),
    environment: { LOCAL_LOGS_ENABLED: "0", LXE_DATA_SERVER_ENABLED: "0" },
    emitter: { emit: async () => {}, typing: async () => {} },
  });
  const audit = spyOn(PermissionApprovalService.prototype, "stop").mockRejectedValueOnce(new Error("ENOSPC: transcript audit"));
  const processes = spyOn(CodingProcessManager.prototype, "stop");
  try {
    await host.start();
    await expect(host.stop()).rejects.toThrow("ENOSPC: transcript audit");
    expect(processes).toHaveBeenCalledTimes(1);
    expect(host.health().ready).toBe(false);
  } finally {
    audit.mockRestore(); processes.mockRestore(); await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop host exposes exec without a managed lxeskill tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-exec-host-"));
  const workspaceRoot = join(root, "workspace"), skills = join(root, "skills"), soul = join(root, "SOUL.md");
  mkdirSync(workspaceRoot); mkdirSync(skills); writeFileSync(soul, "Synthetic test instructions");
  let managed: ToolDefinition | undefined;
  const original = ToolRegistry.prototype.register;
  const registration = spyOn(ToolRegistry.prototype, "register").mockImplementation(function(this: ToolRegistry, definition) {
    if (definition.name === "managed_lxeskill") managed = definition;
    return original.call(this, definition);
  });
  const runner = spyOn(OneShotCliRunner.prototype, "execute");
  const host = createAgentRuntimeHost({
    dataRoot: root, legacyWorkspace: { directory: workspaceRoot, worktree: workspaceRoot },
    agentSoulPath: soul, skillsRoot: skills, userSkillsRoot: join(root, "user"),
    llmConfigRoot: join(repositoryRoot(import.meta.dir), "config", "llm"),
    lxeskillCatalogPath: join(repositoryRoot(import.meta.dir), "python", "lxeskill_cli", "lxeskill", "catalog.json"),
    environment: { LOCAL_LOGS_ENABLED: "0", LXE_DATA_SERVER_ENABLED: "0", LXE_MANAGED_PYTHON: process.execPath },
    emitter: { emit: async () => {}, typing: async () => {} },
  });
  try {
    expect(managed).toBeUndefined();
    expect(registration.mock.calls.map(([definition]) => definition.name)).toContain("exec");
    expect(runner).not.toHaveBeenCalled();
  } finally {
    registration.mockRestore(); runner.mockRestore(); await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});
