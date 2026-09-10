import { withV3Definitions } from "../../../packages/foundation/core/test/managed-v3-fixtures";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, type ManagedLlmState } from "@lxe/core";
import { SqliteRuntimeStore, ToolRegistry, AtomicRuntimeProviderManager } from "@lxe/runtime";
import { DashboardService } from "../src/dashboard-service";

test("published alternatives enforce model membership and freeze each acquired turn's credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-managed-runtime-")); const repo = repositoryRoot(import.meta.dir);
  const environment = { AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "cloud-future-flash", AGENT_LLM_CREDENTIAL_SOURCE: "cloud" };
  let state: ManagedLlmState = { revision: 1, default_target: { provider: "deepseek", model: "cloud-future-flash" },
    models: ["cloud-future-flash", "cloud-future-pro"].map((model, i) => ({ provider: "deepseek", model, available: true, credential_revision: (i ? "b" : "a").repeat(64) })),
    credentials: ["cloud-future-flash", "cloud-future-pro"].map((model, i) => ({ provider: "deepseek", model, api_key: "key-" + model, credential_revision: (i ? "b" : "a").repeat(64), fetched_at: 1, invalid_revision: "" })) };
  state = withV3Definitions(state);
  const used: string[] = [];
  const manager = new AtomicRuntimeProviderManager(repo, environment, (d) => ({ summarize: async () => ({ text: "", usage: { input_tokens: 0, output_tokens: 0 } }),
    turn: async () => { used.push(d.apiKey); return { id: "test", role: "assistant", timestamp: 1, api: "openai_responses", provider: d.name, model: d.model, content: [], stopReason: "stop", usage: { input_tokens: 0, output_tokens: 0, status: "complete" } }; } }),
    join(repo, "config/llm"), undefined, () => state);
  const store = new SqliteRuntimeStore(join(root, "test.sqlite3"));
  try {
    await store.start();
    const service = new DashboardService({ stateRoot: root, llmConfigRoot: join(repo, "config/llm"), skillsRoot: join(root, "skills"), userSkillsRoot: join(root, "user-skills"), environment, store, tools: new ToolRegistry(), mcpConfig: { servers: [] }, providerManager: manager, managedLlmState: () => state });
    const list = await service.call({ operation: "models.list", input: {} });
    expect(list.items.filter((m) => m.credential_source === "cloud").map((m) => m.model)).toEqual(["cloud-future-flash", "cloud-future-pro"]);
    expect(JSON.stringify(list)).not.toContain("key-deepseek");
    const first = manager.acquire();
    await service.call({ operation: "models.update", input: { provider: "deepseek", model: "cloud-future-pro", credential_source: "cloud" } });
    expect(environment.AGENT_LLM_MODEL).toBe("cloud-future-pro");
    await expect(service.call({ operation: "models.update", input: { provider: "kimi_coding", model: "k3", credential_source: "cloud" } })).rejects.toThrow("Unsupported managed");
    const pro = manager.acquire();
    state = { ...state, revision: 2, models: state.models.slice(0, 1), credentials: state.credentials.slice(0, 1) };
    const blocked = await manager.reconfigure({});
    const request = { system: "", messages: [], tools: [], toolChoice: "none" as const, signal: new AbortController().signal };
    await first.provider.turn(request); await pro.provider.turn(request);
    expect(used).toEqual(["key-cloud-future-flash", "key-cloud-future-pro"]);
    await expect(blocked.provider.turn(request)).rejects.toThrow();
    Object.assign(environment, { LXE_MANAGED_LLM_PROVIDER: "future_vendor", LXE_MANAGED_LLM_MODEL: "future-model" });
    environment.AGENT_LLM_MODEL = "cloud-future-flash";
    const unsupportedDefault = await manager.reconfigure({});
    await expect(unsupportedDefault.provider.turn(request)).rejects.toThrow();
    await service.call({ operation: "models.update", input: { provider: "deepseek", model: "cloud-future-flash", credential_source: "cloud" } });
    await manager.acquire().provider.turn(request);
    expect(used.at(-1)).toBe("key-cloud-future-flash");
  } finally { await store.stop(); rmSync(root, { recursive: true, force: true }); }
});
