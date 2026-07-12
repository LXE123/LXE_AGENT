import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore, ToolRegistry, type RuntimeProviderManager } from "@lxe/runtime";
import { DashboardApi } from "./dashboard-api";

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
    mkdirSync(join(root, "packages", "runtime", "config", "providers"), { recursive: true });
    writeFileSync(join(root, "packages", "runtime", "config", "providers", "kimi_coding.json"), JSON.stringify({
      name: "kimi_coding",
      label: "Kimi Coding",
      api_style: "anthropic_messages",
      default_model: "kimi-for-coding",
      models: { "kimi-for-coding": { max_tokens: 4096, thinking_levels: ["off"] } },
    }), "utf8");
    writeFileSync(join(root, "packages", "runtime", "config", "auth-profiles.json"), JSON.stringify({
      profiles: { kimi_coding: { env_names: ["KIMI_API_KEY"] } },
    }), "utf8");

    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "session-one", source: { platform: "feishu", chat_type: "p2p" } });
    await store.appendMessage("session-one", { role: "user", content: "hello" });
    const tools = new ToolRegistry();
    tools.register({
      name: "demo_tool",
      description: "Demo tool",
      input_schema: { type: "object", properties: {} },
      execute: async () => ({ content: [] }),
    });
    const reconfigured: unknown[] = [];
    const providerManager: RuntimeProviderManager = {
      acquire: () => { throw new Error("not needed by Dashboard test"); },
      reconfigure: async (patch, persist) => {
        reconfigured.push(patch);
        await persist?.({
          AGENT_LLM_PROVIDER: patch.provider ?? "kimi_coding",
          AGENT_LLM_MODEL: patch.model ?? "kimi-for-coding",
          AGENT_LLM_THINKING_ENABLED: patch.thinkingEnabled === false ? "0" : "1",
          AGENT_LLM_THINKING_EFFORT: patch.thinkingEffort ?? "off",
        });
        return {
          generation: 2,
          descriptor: {
            name: patch.provider ?? "kimi_coding", model: patch.model ?? "kimi-for-coding",
            baseURL: "", apiKey: "", maxTokens: 4096, defaultHeaders: {}, thinkingStyle: "none",
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
      environment: { KIMI_API_KEY: "test-key" },
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
      providerManager,
    });
    const call = async (path: string, init?: RequestInit) => {
      const request = new Request(`http://dashboard${path}`, init);
      const response = await api.handle(request, new URL(request.url));
      return { status: response?.status, body: await response?.json() };
    };

    expect((await call("/api/sessions?q=session-one")).body).toMatchObject({ total: 1, summary: { total_sessions: 1 } });
    expect((await call("/api/sessions/session-one?message_limit=10")).body).toMatchObject({
      session: { session_id: "session-one" }, messages: [{ role: "user", content: "hello" }],
    });
    expect((await call("/api/project-docs")).body).toMatchObject({ items: [{ path: "guide.md", title: "Guide" }], total: 1 });
    expect((await call("/api/project-docs/guide.md")).body).toMatchObject({ path: "guide.md", content: "# Guide\n\nstatus: ready\n" });
    expect((await call("/api/project-docs/%2e%2e%2FSOUL.md")).status).toBe(404);
    expect((await call("/api/skills")).body).toMatchObject({ items: [{ name: "demo", commands: ["scripts.demo"], references: [{ path: "references/help.md" }] }] });
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
    expect((await call("/api/stats/overview?days=7")).body).toMatchObject({ days: 7, totals: { turns: 0, input_tokens: 0 } });
    expect((await call("/api/models")).body).toMatchObject({
      items: [{ provider: "kimi_coding", model: "kimi-for-coding", configured: true }],
    });
    expect((await call("/api/models/current")).body).toMatchObject({ provider: "kimi_coding" });
    expect((await call("/api/models/current", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "kimi_coding", model: "kimi-for-coding" }),
    })).body).toMatchObject({ provider: "kimi_coding", model: "kimi-for-coding", generation: 2, effective_from: "next_turn" });
    expect(reconfigured).toEqual([expect.objectContaining({ provider: "kimi_coding", model: "kimi-for-coding" })]);

    const connectors = (await call("/api/connectors")).body as { total: number; items: Array<Record<string, unknown>> };
    expect(connectors.total).toBe(2);
    expect(connectors.items[0]).toMatchObject({ id: "feishu", enabled: false });
    expect((await call("/api/connectors/feishu", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    })).body).toMatchObject({ id: "feishu", enabled: true, everConnected: true });
    await store.stop();
  });
});
