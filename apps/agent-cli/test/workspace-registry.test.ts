import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore, ToolRegistry } from "@lxe/runtime";
import { DashboardService } from "../src/dashboard-service";

test("register canonical directories without sessions, reuse aliases, and expose actual path errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-register-rpc-"));
  const directory = join(root, "资料"), alias = join(root, "alias");
  mkdirSync(directory);
  symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const file = join(root, "file.txt");
  writeFileSync(file, "fixture");
  const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
  await store.start();
  const service = new DashboardService({ stateRoot: root, llmConfigRoot: join(root, "llm"),
    skillsRoot: join(root, "skills"), userSkillsRoot: join(root, "user"), environment: {},
    store, tools: new ToolRegistry(), mcpConfig: { servers: [] } });
  const register = (directory: string) => service.call({ operation: "workspaces.register", input: { directory } });
  const rename = (workspace_id: string, display_name: string) => service.call({ operation: "workspaces.rename", input: { workspace_id, display_name } });
  try {
    const saved = await register(directory);
    expect(saved).toMatchObject({ directory: realpathSync.native(directory), session_count: 0, display_name: null });
    await rename(saved.workspace_id, "  采购  ");
    expect(await register(alias)).toEqual({ ...saved, display_name: "采购" });
    expect(await register(join(directory, "."))).toEqual({ ...saved, display_name: "采购" });
    expect((await service.call({ operation: "sessions.workspaces", input: {} })).items).toHaveLength(1);
    expect(store.listSessions({ limit: 10, offset: 0 }).total).toBe(0);
    await expect(register(join(root, "missing"))).rejects.toThrow("ENOENT");
    await expect(register(file)).rejects.toThrow("not a directory");
    await expect(register("relative/path")).rejects.toThrow("absolute path");
    await expect(rename(join(root, "unknown"), "name")).rejects.toThrow("workspace not found");
    rmSync(alias, { recursive: true, force: true });
    rmSync(directory, { recursive: true });
    expect((await rename(saved.workspace_id, "Offline")).display_name).toBe("Offline");
    expect((await rename(saved.workspace_id, "  ")).display_name).toBeNull();
  } finally { await store.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test("workspace deletion addresses the registration, retains live sessions, and rejects stale ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-delete-rpc-"));
  const store = new SqliteRuntimeStore(join(root, "agent.sqlite3")); await store.start();
  const stopped: string[] = [];
  const service = new DashboardService({ stateRoot: root, llmConfigRoot: root, skillsRoot: root, userSkillsRoot: root,
    environment: {}, store, tools: new ToolRegistry(), mcpConfig: { servers: [] }, terminateSession: id => { stopped.push(id); } });
  try {
    const registration = await service.call({ operation: "workspaces.register", input: { directory: root } });
    const blank = await service.call({ operation: "sessions.create", input: { workspace_id: registration.workspace_id } });
    await store.appendPendingEvent(blank.session_id, { event_id: "queued", text: "Continue later" });
    expect(await service.call({ operation: "workspaces.delete", input: { workspace_id: registration.workspace_id } })).toEqual({ deleted: true });
    expect(store.sessionMetadata(blank.session_id)).toMatchObject({ workspace_id: null, workspace: blank.workspace });
    expect(await store.hasPendingEvents(blank.session_id)).toBe(true);
    expect(stopped).toEqual([]);
    const next = await service.call({ operation: "workspaces.register", input: { directory: root } });
    expect(next.workspace_id).not.toBe(registration.workspace_id);
    for (const operation of ["workspaces.delete", "sessions.create"] as const) {
      await expect(service.call({ operation, input: { workspace_id: registration.workspace_id } })).rejects.toThrow("workspace not found");
    }
    await expect(service.call({ operation: "workspaces.rename", input: { workspace_id: registration.workspace_id, display_name: "Late rename" } })).rejects.toThrow("workspace not found");
    expect((await service.call({ operation: "sessions.workspaces", input: {} })).items[0]?.display_name).toBeNull();
  } finally { await store.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
