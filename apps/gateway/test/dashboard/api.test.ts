import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore, ToolRegistry, type RuntimeProviderManager } from "@lxe/runtime";
import { DashboardApi } from "../../src/dashboard/api";
import { loadProjectEnv } from "../../src/bootstrap/env";
import { workspaceFor } from "../workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DashboardApi", () => {
  test("serves the production session, docs, skill, connector, tool, stats, and task contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-api-"));
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "guide.md"), "# Guide\n\nstatus: ready\n", "utf8");
    mkdirSync(join(root, "skills", "demo", "references"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "description: Demo skill", "type: default", "commands: [scripts.demo]", "references:",
      "  - path: references/help.md", "    description: Help", "---", "# Demo", "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "skills", "demo", "references", "help.md"), "# Help", "utf8");
    mkdirSync(join(root, "config", "llm", "providers"), { recursive: true });
    writeFileSync(join(root, "config", "llm", "providers", "kimi-coding.json"), JSON.stringify({
      name: "kimi_coding",
      label: "Kimi Coding",
      api_style: "anthropic_messages",
      aliases: ["kimi-coding", "kimi_code", "kimi-code"],
      default_model: "kimi-for-coding",
      models: {
        "kimi-for-coding": {
          context_window_tokens: 256_000, max_tokens: 32_768, supports_vision: true, supports_thinking: true,
          thinking_request_style: "anthropic-adaptive", thinking_levels: ["off", "low", "medium", "high"],
          thinking_default: "medium",
        },
        k3: {
          context_window_tokens: 262_144, max_tokens: 131_072, supports_vision: true, supports_thinking: true,
          thinking_request_style: "anthropic-adaptive", thinking_levels: ["off", "max"], thinking_default: "max",
        },
      },
    }), "utf8");
    writeFileSync(join(root, "config", "llm", "providers", "deepseek.json"), JSON.stringify({
      name: "deepseek",
      label: "DeepSeek",
      api_style: "anthropic_messages",
      aliases: ["deep-seek"],
      default_model: "deepseek-v4-pro",
      models: {
        "deepseek-v4-pro": { max_tokens: 384_000, thinking_levels: ["off", "high"], thinking_default: "high" },
      },
    }), "utf8");
    writeFileSync(join(root, "config", "llm", "auth-profiles.json"), JSON.stringify({
      profiles: {
        kimi_coding: { env_names: ["KIMI_API_KEY"] },
        deepseek: { env_names: ["DEEPSEEK_API"] },
      },
    }), "utf8");

    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: workspaceFor(root), session_id: "session-one", source: { platform: "feishu", chat_type: "p2p" } });
    await store.appendMessage("session-one", { role: "user", content: "hello" });
    await store.appendMessage("session-one", {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "demo_tool", arguments: {} }],
    });
    await store.appendMessage("session-one", {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "call-1", content: "ok" }],
    });
    await store.appendMessage("session-one", { role: "assistant", content: "done" });
    await store.recordTurn("session-one", {
      turn_id: "turn-one", started_at: Date.now() / 1_000, status: "completed", elapsed_ms: 15,
      input_tokens: 3, output_tokens: 2, tool_calls: 1, api_calls: 1, tools: [],
      activations: [{ skill: "demo", module: "default" }],
      executions: [{ skill: "demo", module: "default", command: "scripts.demo", success: false, duration_ms: 12 }],
    });
    const tools = new ToolRegistry();
    tools.register({
      name: "demo_tool",
      description: "Demo tool",
      input_schema: { type: "object", properties: {} },
      execute: async () => ({ content: [] }),
    });
    const reconfigured: unknown[] = [];
    const environment: Record<string, string> = {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_API_KEY: "test-key",
      DEEPSEEK_API: "deepseek-key",
    };
    let providerGeneration = 1;
    const providerManager: RuntimeProviderManager = {
      acquire: () => { throw new Error("not needed by Dashboard test"); },
      reconfigure: async (patch, persist) => {
        reconfigured.push(patch);
        const environmentPatch = {
          AGENT_LLM_PROVIDER: patch.provider ?? environment.AGENT_LLM_PROVIDER ?? "kimi_coding",
          AGENT_LLM_MODEL: patch.model ?? environment.AGENT_LLM_MODEL ?? "kimi-for-coding",
          AGENT_LLM_THINKING_ENABLED: patch.thinkingEnabled === false ? "0" : "1",
          AGENT_LLM_THINKING_EFFORT: patch.thinkingEffort ?? "off",
        };
        await persist?.(environmentPatch);
        Object.assign(environment, environmentPatch);
        return {
          generation: ++providerGeneration,
          descriptor: {
            name: patch.provider ?? "kimi_coding", model: patch.model ?? "kimi-for-coding",
            baseURL: "", apiKey: "", maxTokens: 4096, defaultHeaders: {}, thinkingStyle: "none",
            thinkingLevels: ["off"], thinkingDefault: "off",
            thinkingEnabled: patch.thinkingEnabled ?? false, thinkingEffort: patch.thinkingEffort ?? "off",
            thinkingDisplay: "omitted", contextWindowTokens: 200_000, requestIdleTimeoutMs: 30_000,
          },
          provider: {
            summarize: async () => ({ text: "", usage: { input_tokens: 0, output_tokens: 0 } }),
            turn: async () => ({ content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }),
          },
        };
      },
    };
    const api = new DashboardApi({
      projectRoot: root,
      environment,
      store,
      tools,
      mcpConfig: { servers: [{
        name: "inventory", enabled: true, transport: "streamable-http", command: "", args: [], env: {}, cwd: "",
        url: "https://mcp.example.test", headers: { Authorization: "secret-static" },
        envHeaders: { "X-Secret": "MCP_SECRET" }, bearerTokenEnvVar: "MCP_BEARER",
        connectorId: "inventory-connector", connectorName: "Inventory Connector",
        connectorDescription: "Reads inventory", startupTimeoutMs: 10_000, toolTimeoutMs: 60_000,
        enabledTools: new Set(), disabledTools: new Set(), exposure: "deferred",
      }] },
      mcpStatus: () => ({ connected: true, error: "", toolCount: 7, tools: [{ rawName: "read", modelName: "mcp__inventory__read" }] }),
      connectorStatePath: join(root, "config", "connectors.json"),
      backgroundTasks: () => [{ task_id: "task-1", status: "running" }],
      cliCommands: [{ command: "lxeskill auth refresh", name: "browser_auth_refresh", visibility: "maintenance", ownerSkills: [] }],
      providerManager,
    });
    const call = async (path: string, init?: RequestInit) => {
      const request = new Request(`http://dashboard${path}`, init);
      const response = await api.handle(request, new URL(request.url));
      return { status: response?.status, body: await response?.json() };
    };

    expect((await call("/api/sessions?q=session-one")).body).toMatchObject({ total: 1, summary: { total_sessions: 1 } });
    expect((await call("/api/sessions/session-one?message_limit=1&message_page=2")).body).toMatchObject({
      session: { session_id: "session-one" },
      messages: [{ role: "assistant" }, { role: "tool" }, { role: "assistant" }],
      messages_page: { total: 2, raw_message_total: 4, current_page: 2 },
    });
    expect((await call("/api/project-docs")).body).toMatchObject({ items: [{ path: "guide.md", title: "Guide" }], total: 1 });
    expect((await call("/api/project-docs/guide.md")).body).toMatchObject({ path: "guide.md", content: "# Guide\n\nstatus: ready\n" });
    expect((await call("/api/project-docs/%2e%2e%2FSOUL.md")).status).toBe(404);
    expect((await call("/api/skills")).body).toMatchObject({ items: [{ name: "demo", commands: ["scripts.demo"], references: [{ path: "references/help.md" }] }] });
    expect((await call("/api/commands")).body).toEqual({
      items: [{ command: "lxeskill auth refresh", name: "browser_auth_refresh", visibility: "maintenance", ownerSkills: [] }],
      total: 1,
    });
    expect((await call("/api/skills/demo/content")).body).toMatchObject({ name: "demo", content: expect.stringContaining("# Demo") });
    expect((await call("/api/skills/demo/references/references%2Fhelp.md")).body).toMatchObject({ skill_name: "demo", content: "# Help" });
    const toolsets = (await call("/api/tools/toolsets")).body as { items: Array<Record<string, unknown>> };
    expect(toolsets.items.find((item) => item.name === "coding")).toMatchObject({ tools: [{ name: "demo_tool" }] });
    const mcp = (await call("/api/mcp/servers")).body as Record<string, unknown>;
    expect(mcp).toMatchObject({
      items: [{ connector_id: "inventory-connector", connector_name: "Inventory Connector", connector_description: "Reads inventory", tool_count: 7 }],
      tool_total: 7,
    });
    expect(JSON.stringify(mcp)).not.toContain("secret-static");
    expect(JSON.stringify(mcp)).not.toContain("MCP_SECRET");
    expect(JSON.stringify(mcp)).not.toContain("MCP_BEARER");
    expect((await call("/api/background-tasks")).body).toEqual({ items: [{ task_id: "task-1", status: "running" }], total: 1 });
    expect((await call("/api/stats/overview?days=7")).body).toMatchObject({
      days: 7,
      totals: { turns: 1, input_tokens: 3, skill_executions: 1, skill_failures: 1 },
      modules: [{ module: "default", skills: 1, turns: 1, executions: 1, failures: 1, duration_ms: 12 }],
    });
    expect((await call("/api/stats/skills?days=7")).body).toMatchObject({
      days: 7,
      total: 1,
      items: [{
        name: "demo", module: "default", activations: 1, executions: 1, failures: 1,
        execution_turns: 1, duration_ms: 12,
      }],
    });
    expect((await call("/api/stats/skills/demo?days=7")).body).toMatchObject({
      name: "demo", days: 7,
      daily: [{ activations: 1, executions: 1, failures: 1 }],
      recent_failures: [{ turn_id: "turn-one", session_id: "session-one", command: "scripts.demo" }],
    });
    const modelList = (await call("/api/models")).body as { items: Array<Record<string, unknown>> };
    const kimiModel = modelList.items.find((model) => model.provider === "kimi_coding")!;
    expect(kimiModel).toMatchObject({ provider: "kimi_coding", model: "kimi-for-coding", configured: true });
    const kimiOptions = kimiModel.model_options as Array<Record<string, unknown>>;
    expect(kimiOptions.find((option) => option.model === "kimi-for-coding")).toMatchObject({
      thinking_levels: ["off", "low", "medium", "high"], thinking_default: "medium",
    });
    expect(kimiOptions.find((option) => option.model === "k3")).toMatchObject({
      model: "k3", thinking_levels: ["off", "max"], thinking_default: "max",
      capabilities: { context_window_tokens: 262_144, max_output_tokens: 131_072 },
    });
    expect(modelList.items.find((model) => model.provider === "deepseek")).toMatchObject({
      provider: "deepseek", model: "deepseek-v4-pro", configured: true,
    });
    expect((await call("/api/models/current")).body).toMatchObject({ provider: "kimi_coding" });
    Object.assign(environment, {
      AGENT_LLM_MODEL: "k3",
      AGENT_LLM_THINKING_ENABLED: "0",
      AGENT_LLM_THINKING_EFFORT: "low",
    });
    expect((await call("/api/models/current")).body).toMatchObject({
      provider: "kimi_coding", model: "k3",
      thinking_state: { enabled: false, level: "off", editable: true },
    });
    const deepseekSwitch = await call("/api/models/current", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", model: "deepseek-v4-pro" }),
    });
    expect(deepseekSwitch).toMatchObject({
      status: 200,
      body: { provider: "deepseek", model: "deepseek-v4-pro", generation: 2, effective_from: "next_turn" },
    });
    expect((await call("/api/models/current")).body).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
    const modelsAfterDeepseek = (await call("/api/models")).body as { items: Array<Record<string, unknown>> };
    expect(modelsAfterDeepseek.items.find((model) => model.provider === "kimi_coding")).toMatchObject({
      model: "k3",
      thinking_state: { enabled: false, level: "off", editable: true },
    });
    const persistedAfterDeepseek = readFileSync(join(root, ".env.local"), "utf8");
    expect(persistedAfterDeepseek).toContain("AGENT_LLM_MODEL_KIMI_CODING=k3");
    expect(persistedAfterDeepseek).toContain("AGENT_LLM_THINKING_ENABLED_KIMI_CODING=0");
    expect(persistedAfterDeepseek).toContain("AGENT_LLM_THINKING_EFFORT_KIMI_CODING=off");
    expect(persistedAfterDeepseek).toContain("AGENT_LLM_MODEL_DEEPSEEK=deepseek-v4-pro");
    expect(persistedAfterDeepseek).toContain("AGENT_LLM_THINKING_EFFORT_DEEPSEEK=high");

    const restartedEnvironment = loadProjectEnv({
      projectRoot: root,
      initial: { KIMI_API_KEY: "test-key", DEEPSEEK_API: "deepseek-key" },
    });
    const restartedApi = new DashboardApi({
      projectRoot: root,
      environment: restartedEnvironment,
      store,
      tools,
      mcpConfig: { servers: [] },
    });
    const restartedRequest = new Request("http://dashboard/api/models");
    const restartedResponse = await restartedApi.handle(restartedRequest, new URL(restartedRequest.url));
    const restartedModels = await restartedResponse?.json() as { items: Array<Record<string, unknown>> };
    expect(restartedModels.items.find((model) => model.provider === "kimi_coding")).toMatchObject({
      model: "k3",
      thinking_state: { enabled: false, level: "off", editable: true },
    });

    const kimiSwitch = await call("/api/models/current", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "kimi_coding" }),
    });
    expect(kimiSwitch).toMatchObject({
      status: 200,
      body: {
        provider: "kimi_coding", model: "k3", generation: 3, effective_from: "next_turn",
        thinking_state: { enabled: false, level: "off", editable: true },
      },
    });

    const k3Max = await call("/api/models/current/thinking", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "max" }),
    });
    expect(k3Max).toMatchObject({
      status: 200,
      body: {
        provider: "kimi_coding", model: "k3", generation: 4, effective_from: "next_turn",
        thinking_levels: ["off", "max"],
        thinking_state: { enabled: true, level: "max", editable: true },
        capabilities: { context_window_tokens: 262_144, max_output_tokens: 131_072 },
      },
    });

    expect(await call("/api/models/current", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "deepseek" }),
    })).toMatchObject({
      status: 200,
      body: { provider: "deepseek", model: "deepseek-v4-pro", generation: 5 },
    });
    expect(await call("/api/models/current", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "kimi_coding" }),
    })).toMatchObject({
      status: 200,
      body: {
        provider: "kimi_coding", model: "k3", generation: 6,
        thinking_state: { enabled: true, level: "max", editable: true },
      },
    });
    environment.AGENT_LLM_MODEL_DEEPSEEK = "retired-model";
    const modelsWithRetiredPreference = (await call("/api/models")).body as { items: Array<Record<string, unknown>> };
    expect(modelsWithRetiredPreference.items.find((model) => model.provider === "deepseek")).toMatchObject({
      model: "deepseek-v4-pro",
    });

    const kimiAliasSwitch = await call("/api/models/current", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "kimi-code", model: "kimi-for-coding" }),
    });
    expect(kimiAliasSwitch).toMatchObject({
      status: 200,
      body: { provider: "kimi_coding", model: "kimi-for-coding", generation: 7 },
    });
    expect(await call("/api/models/current", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "../kimi_coding", model: "kimi-for-coding" }),
    })).toMatchObject({ status: 400, body: { detail: "Unsupported model provider" } });
    expect(reconfigured).toEqual([
      expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-pro" }),
      expect.objectContaining({ provider: "kimi_coding", model: "k3", thinkingEffort: "off" }),
      expect.objectContaining({ thinkingEnabled: true, thinkingEffort: "max" }),
      expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-pro" }),
      expect.objectContaining({ provider: "kimi_coding", model: "k3", thinkingEffort: "max" }),
      expect.objectContaining({ provider: "kimi_coding", model: "kimi-for-coding" }),
    ]);

    const connectors = (await call("/api/connectors")).body as { total: number; items: Array<Record<string, unknown>> };
    expect(connectors.total).toBe(2);
    expect(connectors.items[0]).toMatchObject({ id: "feishu", enabled: false });
    expect(api.runtimeConnectorPolicy()).toEqual({
      disabledSkillNames: expect.any(Set),
      disabledConnectorIds: new Set(["dingtalk", "feishu"]),
    });
    expect(api.runtimeConnectorPolicy().disabledSkillNames).toContain("lark-im");
    expect((await call("/api/connectors/feishu", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    })).body).toMatchObject({ id: "feishu", enabled: true, everConnected: true });
    expect(api.runtimeConnectorPolicy().disabledConnectorIds).toEqual(new Set(["dingtalk"]));
    expect(api.runtimeConnectorPolicy().disabledSkillNames).not.toContain("lark-im");
    await store.stop();
  });
});
