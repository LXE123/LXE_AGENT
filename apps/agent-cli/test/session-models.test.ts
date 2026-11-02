import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "@lxe/core";
import { AtomicRuntimeProviderManager, SqliteRuntimeStore, ToolRegistry } from "@lxe/runtime";
import { DashboardService } from "../src/dashboard-service";

const roots: string[] = [], stores: SqliteRuntimeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function setup(withProvider = false) {
  const root = mkdtempSync(join(tmpdir(), "lxe-model-rpc-")); roots.push(root);
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "fixture" } }));
  const store = new SqliteRuntimeStore(join(root, "agent.sqlite3")); stores.push(store); await store.start();
  for (const id of ["a", "b", "blank"]) await store.ensureSession({ session_id: id, source: {}, workspace: { directory: root, worktree: root } });
  const environment: Record<string, string> = { AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "deepseek-v4-flash", AGENT_LLM_THINKING_EFFORT: "low",
    LXE_MANAGED_LLM_PROVIDER: "deepseek", LXE_MANAGED_LLM_MODEL: "deepseek-v4-flash", LXE_MANAGED_LLM_API_KEY: "fixture", LXE_MANAGED_LLM_CREDENTIAL_REVISION: "c".repeat(64) };
  const llmConfigRoot = join(repositoryRoot(import.meta.dir), "config", "llm");
  const providerManager = withProvider ? new AtomicRuntimeProviderManager(root, environment, () => { throw new Error("Unexpected provider request"); }, llmConfigRoot, join(root, "config", "auth.json")) : undefined;
  const service = new DashboardService({ stateRoot: root, llmConfigRoot, ...(providerManager ? { providerManager } : {}), skillsRoot: join(root, "skills"),
    userSkillsRoot: join(root, "user-skills"), sharedSkillsRoot: false, environment, store, tools: new ToolRegistry(), mcpConfig: { servers: [] } });
  return { store, service, environment, providerManager };
}

test("automation model and effort initialization never changes defaults or the next default conversation", async () => {
  const { store, service, environment, providerManager } = await setup(true);
  const before = await service.call({ operation: "models.current", input: {} });
  const beforeEnvironment = { ...environment };
  const beforeProvider = providerManager!.acquire();
  await service.call({ operation: "models.thinking.update", input: { session_id: "a", level: "high", remember_default: false } });
  expect(await service.call({ operation: "models.current", input: { session_id: "a" } })).toMatchObject({ thinking_state: { level: "high" } });
  expect(await service.call({ operation: "models.current", input: {} })).toEqual(before);
  expect(await service.call({ operation: "models.current", input: { session_id: "blank" } })).toMatchObject({ model: "deepseek-v4-flash", thinking_state: { level: "low" } });
  await service.call({ operation: "models.update", input: { session_id: "b", provider: "deepseek", model: "deepseek-v4-pro", credential_source: "local", remember_default: false } });
  await service.call({ operation: "models.thinking.update", input: { session_id: "b", level: "high", remember_default: false } });
  expect(await service.call({ operation: "models.current", input: {} })).toEqual(before);
  expect(environment).toEqual(beforeEnvironment);
  expect(providerManager!.acquire()).toBe(beforeProvider);
  await store.stop(); await store.start();
  expect(await service.call({ operation: "models.current", input: { session_id: "b" } })).toMatchObject({ model: "deepseek-v4-pro", thinking_state: { level: "high" } });
});

test("session model and effort changes survive restart without changing another conversation", async () => {
  const { store, service, environment } = await setup();
  const current = (session_id: string) => service.call({ operation: "models.current", input: { session_id } });
  await service.call({ operation: "models.update", input: { session_id: "b", provider: "deepseek", model: "deepseek-v4-flash", credential_source: "cloud", selection_version: 0 } });
  await service.call({ operation: "models.update", input: { session_id: "a", provider: "deepseek", model: "deepseek-v4-pro", credential_source: "local", selection_version: 0 } });
  expect(await service.call({ operation: "models.thinking.update", input: { session_id: "a", level: "high", selection_version: 1 } }))
    .toMatchObject({ session_id: "a", model: "deepseek-v4-pro", thinking_state: { level: "high" }, selection_version: 2, effective_from: "next_turn" });
  expect(await current("b")).toMatchObject({ model: "deepseek-v4-flash", credential_source: "cloud", thinking_state: { level: "low" }, selection_version: 1 });
  expect(await current("blank")).toMatchObject({ model: "deepseek-v4-pro", thinking_state: { level: "high" } });
  await store.stop(); await store.start();
  environment.AGENT_LLM_MODEL = "deepseek-v4-flash"; environment.AGENT_LLM_THINKING_EFFORT = "low";
  expect(await current("a")).toMatchObject({ model: "deepseek-v4-pro", thinking_state: { level: "high" }, selection_version: 2 });
  expect(await current("b")).toMatchObject({ credential_source: "cloud", model: "deepseek-v4-flash" });
  await expect(current("missing")).rejects.toThrow("session not found");
  await expect(service.call({ operation: "models.thinking.update", input: { session_id: "a", level: "low", selection_version: 1 } })).rejects.toThrow("expected version 1, current 2");
  await expect(service.call({ operation: "models.thinking.update", input: { session_id: "a", level: "invalid", selection_version: 2 } })).rejects.toThrow("thinking level must be one of");
  expect((await current("a")).selection_version).toBe(2);
});

test.each(["local", "cloud"] as const)("an unavailable persisted %s choice keeps its identity and effort", async (credential_source) => {
  const { store, service } = await setup();
  await store.setSessionModelSelection("a", { provider: "deepseek", model: "removed-model", credential_source, effort: "high", thinking_enabled: true });
  expect(await service.call({ operation: "models.current", input: { session_id: "a" } })).toMatchObject({
    model: "removed-model", credential_source, selectable: false, thinking_state: { level: "high" },
  });
});
