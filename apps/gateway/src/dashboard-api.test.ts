import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore, ToolRegistry } from "@lxe/runtime";
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
      "---", "name: demo", "description: Demo skill", "type: default", "references:",
      "  - path: references/help.md", "    description: Help", "---", "# Demo", "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "skills", "demo", "references", "help.md"), "# Help", "utf8");

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
    const api = new DashboardApi({
      projectRoot: root,
      environment: {},
      store,
      tools,
      mcpConfig: { servers: [] },
      connectorStatePath: join(root, "config", "connectors.json"),
      backgroundTasks: () => [{ task_id: "task-1", status: "running" }],
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
    expect((await call("/api/skills")).body).toMatchObject({ items: [{ name: "demo", references: [{ path: "references/help.md" }] }] });
    expect((await call("/api/skills/demo/content")).body).toMatchObject({ name: "demo", content: expect.stringContaining("# Demo") });
    expect((await call("/api/skills/demo/references/references%2Fhelp.md")).body).toMatchObject({ skill_name: "demo", content: "# Help" });
    expect((await call("/api/tools/toolsets")).body).toMatchObject({ items: [{ name: "coding", tools: [{ name: "demo_tool" }] }] });
    expect((await call("/api/background-tasks")).body).toEqual({ items: [{ task_id: "task-1", status: "running" }], total: 1 });
    expect((await call("/api/stats/overview?days=7")).body).toMatchObject({ days: 7, totals: { turns: 0, input_tokens: 0 } });

    const connectors = (await call("/api/connectors")).body as { total: number; items: Array<Record<string, unknown>> };
    expect(connectors.total).toBe(2);
    expect(connectors.items[0]).toMatchObject({ id: "feishu", enabled: false });
    expect((await call("/api/connectors/feishu", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    })).body).toMatchObject({ id: "feishu", enabled: true, everConnected: true });
    await store.stop();
  });
});
