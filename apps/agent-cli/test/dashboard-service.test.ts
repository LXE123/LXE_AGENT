import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore, ToolRegistry, type RuntimeProviderManager } from "@lxe/runtime";
import type { AgentDashboardRpcCall } from "@lxe/desktop-protocol";
import {
  DASHBOARD_TOOL_RESULT_PAGE_PREVIEW_BYTES,
  DASHBOARD_TOOL_RESULT_PREVIEW_BYTES,
  DashboardService,
  dashboardSessionDetailPreview,
} from "../src/dashboard-service";

const workspaceFor = (directory: string, worktree = directory) => ({ directory, worktree });
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DashboardService", () => {
  test("bounds Dashboard tool result previews without mutating transcript data", () => {
    const large = `HEAD-${"表".repeat(700_000)}-TAIL`;
    const detail = {
      session: { session_id: "large-session" },
      messages: [{
        display_group_id: "group-1",
        role: "tool",
        content: Array.from({ length: 12 }, (_, index) => ({
          type: "tool_result",
          tool_call_id: `tool-${index}`,
          content: large,
        })),
      }],
      messages_page: { oldest_cursor: "group-1", newest_cursor: "group-1" },
    };

    const preview = dashboardSessionDetailPreview(detail) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(detail.messages[0]!.content[0]!.content).toBe(large);
    const results = preview.messages[0]!.content;
    let previewBytes = 0;
    for (const result of results) {
      const content = String(result.content ?? "");
      const truncation = result.dashboard_truncation as {
        truncated: boolean;
        original_bytes: number;
        preview_bytes: number;
      };
      const bytes = Buffer.byteLength(content, "utf8");
      previewBytes += bytes;
      expect(content.startsWith("HEAD-")).toBe(true);
      expect(content.endsWith("-TAIL")).toBe(true);
      expect(bytes).toBeLessThanOrEqual(DASHBOARD_TOOL_RESULT_PREVIEW_BYTES);
      expect(truncation).toEqual({
        truncated: true,
        original_bytes: Buffer.byteLength(large, "utf8"),
        preview_bytes: bytes,
      });
    }
    expect(previewBytes).toBeLessThanOrEqual(DASHBOARD_TOOL_RESULT_PAGE_PREVIEW_BYTES);
  });

  test("serves the production session, skill, connector, tool, stats, and task contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-api-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "demo", "references"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "description: Demo skill", "type: default", "commands: [scripts.demo]", "references:",
      "  - path: references/help.md", "    description: Help", "---", "# Demo", "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "skills", "demo", "references", "help.md"), "# Help", "utf8");
    mkdirSync(join(root, "user-skills", "demo"), { recursive: true });
    writeFileSync(
      join(root, "user-skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: User shadow\n---\n",
      "utf8",
    );
    mkdirSync(join(root, "config", "llm", "providers"), { recursive: true });
    writeFileSync(join(root, "config", "llm", "providers", "kimi-coding.json"), JSON.stringify({
      name: "kimi_coding",
      label: "Kimi Coding",
      api_style: "anthropic_messages",
      aliases: ["kimi-coding", "kimi_code", "kimi-code"],
      default_model: "kimi-for-coding",
      models: {
        "kimi-for-coding": {
          context_window_tokens: 262_144, max_tokens: 32_768, supports_vision: true, supports_thinking: true,
          thinking_request_style: "anthropic-budget", thinking_budget_tokens: 16_000,
          thinking_levels: ["low", "high", "max"], thinking_default: "high",
        },
        k3: {
          context_window_tokens: 262_144, max_tokens: 131_072, supports_vision: true, supports_thinking: true,
          thinking_request_style: "anthropic-output-effort",
          thinking_levels: ["low", "high", "max"], thinking_default: "high",
        },
      },
    }), "utf8");
    writeFileSync(join(root, "config", "llm", "providers", "deepseek.json"), JSON.stringify({
      name: "deepseek",
      label: "DeepSeek",
      api_style: "anthropic_messages",
      aliases: ["deep-seek"],
      default_model: "deepseek-v4-pro",
      request_idle_timeout_ms: 660_000,
      models: {
        "deepseek-v4-pro": {
          context_window_tokens: 1_000_000,
          max_tokens: 384_000,
          thinking_levels: ["off", "high", "max"],
          thinking_default: "high",
        },
        "deepseek-v4-flash": {
          context_window_tokens: 1_000_000,
          max_tokens: 384_000,
          thinking_levels: ["off", "low", "high", "max"],
          thinking_default: "high",
        },
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
    await store.appendMessage("session-one", { role: "user", content: "hello" }, "turn_input", "turn-one");
    await store.appendMessage("session-one", {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "demo_tool", arguments: {} }],
    }, "assistant_response", "turn-one");
    await store.appendMessage("session-one", {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "call-1", content: "ok" }],
    }, "tool_results", "turn-one");
    await store.appendMessage(
      "session-one",
      { role: "assistant", content: "done" },
      "assistant_response",
      "turn-one",
    );
    await store.recordTurn("session-one", {
      turn_id: "turn-one", started_at: Date.now() / 1_000, status: "completed", elapsed_ms: 15,
      input_tokens: 3, output_tokens: 2, tool_calls: 1, api_calls: 1,
      tools: [{ name: "demo_tool", calls: 1, errors: 0, duration_ms: 5 }],
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
    const workspaceReloads: string[] = [];
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
    const service = new DashboardService({
      stateRoot: root,
      llmConfigRoot: join(root, "config", "llm"),
      skillsRoot: join(root, "skills"),
      userSkillsRoot: join(root, "user-skills"),
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
      reloadWorkspace: async (sessionId) => {
        workspaceReloads.push(sessionId);
        return { changed: true, generation: 2, loaded_at: 1, instruction_count: 1, skill_count: 1 };
      },
    });
    const call = (request: AgentDashboardRpcCall): Promise<unknown> => service.call(request);

    expect(await call({ operation: "sessions.list", input: { query: "session-one" } })).toMatchObject({
      total: 1,
      summary: { total_sessions: 1 },
    });
    const latestDetail = await call({
      operation: "sessions.detail",
      input: { session_id: "session-one", message_limit: 1 },
    }) as {
      messages: Array<{
        display_group_id: string;
        role: string;
        turn?: { turn_id: string; status: string | null; elapsed_ms: number | null };
      }>;
      messages_page: { previous_cursor: string };
    };
    const previousCursor = latestDetail.messages_page.previous_cursor;
    expect(latestDetail).toMatchObject({
      session: { session_id: "session-one" },
      messages: [
        { display_group_id: expect.any(String), role: "assistant", turn: { turn_id: "turn-one", status: "completed", elapsed_ms: 15 } },
        { display_group_id: expect.any(String), role: "tool", turn: { turn_id: "turn-one", status: "completed", elapsed_ms: 15 } },
        { display_group_id: expect.any(String), role: "assistant", turn: { turn_id: "turn-one", status: "completed", elapsed_ms: 15 } },
      ],
      messages_page: {
        total: 2,
        raw_message_total: 4,
        previous_cursor: expect.any(String),
        has_previous: true,
      },
    });
    expect(await call({
      operation: "sessions.detail",
      input: {
        session_id: "session-one",
        message_limit: 1,
        message_before: previousCursor,
      },
    })).toMatchObject({ messages: [{ role: "user" }], messages_page: { has_previous: false } });
    const stampedBefore = Date.now();
    const stamped = await call({
      operation: "sessions.detail",
      input: { session_id: "session-one" },
    }) as { messages_page: { fetched_at: number } };
    expect(stamped.messages_page.fetched_at).toBeGreaterThanOrEqual(stampedBefore);
    expect(stamped.messages_page.fetched_at).toBeLessThanOrEqual(Date.now());
    await expect(call({ operation: "sessions.detail", input: { session_id: "missing" } }))
      .rejects.toMatchObject({ code: "not_found", message: "session not found" });
    await expect(call({
      operation: "sessions.detail",
      input: { session_id: "session-one", message_before: "not-a-cursor" },
    })).rejects.toMatchObject({ code: "invalid_argument", message: expect.stringContaining("cursor") });
    expect(await call({ operation: "sessions.workspace.reload", input: { session_id: "session-one" } }))
      .toMatchObject({ changed: true, generation: 2 });
    expect(workspaceReloads).toEqual(["session-one"]);
    expect(await call({ operation: "skills.list", input: {} })).toMatchObject({
      items: [{
        name: "demo",
        source: "repository",
        commands: ["scripts.demo"],
        references: [{ path: "references/help.md" }],
        diagnostics: [{ code: "user_skill_shadowed", skill_name: "demo" }],
      }],
    });
    expect(await call({ operation: "commands.list", input: {} })).toEqual({
      items: [{ command: "lxeskill auth refresh", name: "browser_auth_refresh", visibility: "maintenance", ownerSkills: [] }],
      total: 1,
    });
    expect(await call({ operation: "skills.content", input: { name: "demo" } }))
      .toMatchObject({ name: "demo", content: expect.stringContaining("# Demo") });
    await expect(call({ operation: "skills.content", input: { name: "missing" } }))
      .rejects.toMatchObject({ code: "not_found", message: "skill not found" });
    expect(await call({ operation: "skills.reference", input: { name: "demo", path: "references/help.md" } }))
      .toMatchObject({ skill_name: "demo", content: "# Help" });
    const toolsets = await call({ operation: "toolsets.list", input: {} }) as { items: Array<Record<string, unknown>> };
    expect(toolsets.items.find((item) => item.name === "coding")).toMatchObject({ tools: [{ name: "demo_tool" }] });
    const mcp = await call({ operation: "mcp.servers.list", input: {} }) as Record<string, unknown>;
    expect(mcp).toMatchObject({
      items: [{ connector_id: "inventory-connector", connector_name: "Inventory Connector", connector_description: "Reads inventory", tool_count: 7 }],
      tool_total: 7,
    });
    expect(JSON.stringify(mcp)).not.toContain("secret-static");
    expect(JSON.stringify(mcp)).not.toContain("MCP_SECRET");
    expect(JSON.stringify(mcp)).not.toContain("MCP_BEARER");
    expect(await call({ operation: "mcp.servers.update", input: { name: "inventory", enabled: false } }))
      .toMatchObject({ name: "inventory", enabled: false, status: "disabled" });
    expect(await call({ operation: "backgroundTasks.list", input: {} }))
      .toEqual({ items: [{ task_id: "task-1", status: "running" }], total: 1 });
    expect(await call({ operation: "stats.overview", input: { days: 7 } })).toMatchObject({
      days: 7,
      totals: { turns: 1, input_tokens: 3, skill_executions: 1, skill_failures: 1 },
      modules: [{ module: "default", skills: 1, turns: 1, executions: 1, failures: 1, duration_ms: 12 }],
    });
    expect(await call({ operation: "stats.skills.list", input: { days: 7 } })).toMatchObject({
      days: 7,
      total: 1,
      items: [{
        name: "demo", module: "default", activations: 1, executions: 1, failures: 1,
        execution_turns: 1, duration_ms: 12,
      }],
    });
    expect(await call({ operation: "stats.skills.detail", input: { name: "demo", days: 7 } })).toMatchObject({
      name: "demo", days: 7,
      daily: [{ activations: 1, executions: 1, failures: 1 }],
      recent_failures: [{ turn_id: "turn-one", session_id: "session-one", command: "scripts.demo" }],
    });
    expect(await call({ operation: "stats.tools.list", input: { days: 7 } })).toMatchObject({
      days: 7,
      items: [{ name: "demo_tool", calls: 1 }],
    });
    const modelList = await call({ operation: "models.list", input: {} }) as { items: Array<Record<string, unknown>> };
    const kimiModel = modelList.items.find((model) => model.provider === "kimi_coding")!;
    expect(kimiModel).toMatchObject({ provider: "kimi_coding", model: "kimi-for-coding", configured: true });
    const kimiOptions = kimiModel.model_options as Array<Record<string, unknown>>;
    expect(kimiOptions.find((option) => option.model === "kimi-for-coding")).toMatchObject({
      thinking_levels: ["low", "high", "max"], thinking_default: "high",
      capabilities: { context_window_tokens: 262_144, max_output_tokens: 32_768 },
    });
    expect(kimiOptions.find((option) => option.model === "k3")).toMatchObject({
      model: "k3", thinking_levels: ["low", "high", "max"], thinking_default: "high",
      capabilities: { context_window_tokens: 262_144, max_output_tokens: 131_072 },
    });
    const deepseekModel = modelList.items.find((model) => model.provider === "deepseek")!;
    expect(deepseekModel).toMatchObject({
      provider: "deepseek", model: "deepseek-v4-pro", configured: true,
    });
    const deepseekOptions = deepseekModel.model_options as Array<Record<string, unknown>>;
    expect(deepseekOptions.find((option) => option.model === "deepseek-v4-flash")).toMatchObject({
      thinking_levels: ["off", "low", "high", "max"],
      thinking_default: "high",
      capabilities: { context_window_tokens: 1_000_000, max_output_tokens: 384_000 },
    });
    expect(await call({ operation: "models.current", input: {} })).toMatchObject({ provider: "kimi_coding" });
    Object.assign(environment, {
      AGENT_LLM_MODEL: "k3",
      AGENT_LLM_THINKING_ENABLED: "0",
      AGENT_LLM_THINKING_EFFORT: "off",
    });
    expect(await call({ operation: "models.current", input: {} })).toMatchObject({
      provider: "kimi_coding", model: "k3",
      thinking_state: { enabled: true, level: "high", editable: true },
    });
    const deepseekSwitch = await call({
      operation: "models.update",
      input: { provider: "deepseek", model: "deepseek-v4-pro" },
    });
    expect(deepseekSwitch).toMatchObject({
      provider: "deepseek", model: "deepseek-v4-pro", generation: 2, effective_from: "next_turn",
    });
    expect(await call({ operation: "models.current", input: {} }))
      .toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
    const modelsAfterDeepseek = await call({ operation: "models.list", input: {} }) as { items: Array<Record<string, unknown>> };
    expect(modelsAfterDeepseek.items.find((model) => model.provider === "kimi_coding")).toMatchObject({
      model: "k3",
      thinking_state: { enabled: true, level: "high", editable: true },
    });
    expect(environment).toMatchObject({
      AGENT_LLM_MODEL_KIMI_CODING: "k3",
      AGENT_LLM_THINKING_ENABLED_KIMI_CODING: "1",
      AGENT_LLM_THINKING_EFFORT_KIMI_CODING: "high",
      AGENT_LLM_MODEL_DEEPSEEK: "deepseek-v4-pro",
      AGENT_LLM_THINKING_EFFORT_DEEPSEEK: "high",
    });
    expect(existsSync(join(root, ".env.local"))).toBeFalse();

    const restartedService = new DashboardService({
      stateRoot: root,
      llmConfigRoot: join(root, "config", "llm"),
      skillsRoot: join(root, "skills"),
      userSkillsRoot: join(root, "user-skills"),
      environment: { ...environment },
      store,
      tools,
      mcpConfig: { servers: [] },
    });
    const restartedModels = await restartedService.call({
      operation: "models.list",
      input: {},
    }) as { items: Array<Record<string, unknown>> };
    expect(restartedModels.items.find((model) => model.provider === "kimi_coding")).toMatchObject({
      model: "k3",
      thinking_state: { enabled: true, level: "high", editable: true },
    });
    await expect(restartedService.call({
      operation: "sessions.workspace.reload",
      input: { session_id: "session-one" },
    })).rejects.toMatchObject({ code: "unavailable", message: "workspace reload is unavailable" });

    const kimiSwitch = await call({ operation: "models.update", input: { provider: "kimi_coding" } });
    expect(kimiSwitch).toMatchObject({
      provider: "kimi_coding", model: "k3", generation: 3, effective_from: "next_turn",
      thinking_state: { enabled: true, level: "high", editable: true },
    });

    const k3Max = await call({ operation: "models.thinking.update", input: { level: "max" } });
    expect(k3Max).toMatchObject({
      provider: "kimi_coding", model: "k3", generation: 4, effective_from: "next_turn",
      thinking_levels: ["low", "high", "max"],
      thinking_state: { enabled: true, level: "max", editable: true },
      capabilities: { context_window_tokens: 262_144, max_output_tokens: 131_072 },
    });

    expect(await call({ operation: "models.update", input: { provider: "deepseek" } }))
      .toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", generation: 5 });
    expect(await call({ operation: "models.update", input: { provider: "kimi_coding" } })).toMatchObject({
      provider: "kimi_coding", model: "k3", generation: 6,
      thinking_state: { enabled: true, level: "max", editable: true },
    });
    environment.AGENT_LLM_MODEL_DEEPSEEK = "retired-model";
    const modelsWithRetiredPreference = await call({ operation: "models.list", input: {} }) as { items: Array<Record<string, unknown>> };
    expect(modelsWithRetiredPreference.items.find((model) => model.provider === "deepseek")).toMatchObject({
      model: "deepseek-v4-pro",
    });

    const kimiAliasSwitch = await call({
      operation: "models.update",
      input: { provider: "kimi-code", model: "kimi-for-coding" },
    });
    expect(kimiAliasSwitch).toMatchObject({
      provider: "kimi_coding", model: "kimi-for-coding", generation: 7,
    });
    await expect(call({
      operation: "models.update",
      input: { provider: "../kimi_coding", model: "kimi-for-coding" },
    })).rejects.toMatchObject({ code: "invalid_argument", message: "Unsupported model provider" });
    await expect(call({ operation: "models.thinking.update", input: { level: "impossible" } }))
      .rejects.toMatchObject({ code: "invalid_argument" });
    delete environment.DEEPSEEK_API;
    await expect(call({ operation: "models.update", input: { provider: "deepseek" } }))
      .rejects.toMatchObject({ code: "failed_precondition", message: "missing API key" });
    environment.DEEPSEEK_API = "deepseek-key";
    expect(reconfigured).toEqual([
      expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-pro" }),
      expect.objectContaining({ provider: "kimi_coding", model: "k3", thinkingEffort: "high" }),
      expect.objectContaining({ thinkingEnabled: true, thinkingEffort: "max" }),
      expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-pro" }),
      expect.objectContaining({ provider: "kimi_coding", model: "k3", thinkingEffort: "max" }),
      expect.objectContaining({ provider: "kimi_coding", model: "kimi-for-coding" }),
    ]);

    const connectors = await call({ operation: "connectors.list", input: {} }) as { total: number; items: Array<Record<string, unknown>> };
    expect(connectors.total).toBe(2);
    expect(connectors.items[0]).toMatchObject({ id: "feishu", enabled: false });
    expect(service.runtimeConnectorPolicy()).toEqual({
      disabledSkillNames: expect.any(Set),
      disabledConnectorIds: new Set(["dingtalk", "feishu"]),
    });
    expect(service.runtimeConnectorPolicy().disabledSkillNames).toContain("lark-im");
    expect(await call({ operation: "connectors.update", input: { id: "feishu", enabled: true } }))
      .toMatchObject({ id: "feishu", enabled: true, everConnected: true });
    expect(service.runtimeConnectorPolicy().disabledConnectorIds).toEqual(new Set(["dingtalk"]));
    expect(service.runtimeConnectorPolicy().disabledSkillNames).not.toContain("lark-im");
    expect(await call({ operation: "sessions.pin", input: { session_id: "session-one", pinned: true } }))
      .toMatchObject({ session_id: "session-one", pinned_at: expect.any(Number) });
    await expect(call({ operation: "sessions.pin", input: { session_id: "missing", pinned: true } }))
      .rejects.toMatchObject({ code: "not_found", message: "session not found" });
    await expect(call({ operation: "sessions.delete", input: { session_id: "missing" } }))
      .rejects.toMatchObject({ code: "not_found", message: "session not found" });
    expect(await call({ operation: "sessions.delete", input: { session_id: "session-one" } }))
      .toEqual({ session_id: "session-one", deleted: true });
    expect(await call({ operation: "sessions.list", input: { query: "session-one" } }))
      .toMatchObject({ total: 0, items: [] });
    await store.stop();
  });
});
