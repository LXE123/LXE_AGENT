import { PermissionPolicyService } from "../../src/permissions/policy";
import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceContext } from "@lxe/core";
import type { AgentJob, JsonObject } from "@lxe/protocol";
import { TypeScriptAgentRuntime } from "../../src/engine/runtime";
import type { RuntimeMessage } from "../../src/engine/types";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { McpManager } from "../../src/tooling/mcp";
import { ToolRegistry } from "../../src/tooling/registry";
import { messageFixture } from "../message-fixtures";
import { removeTemporaryRoot } from "../temp-directory";

const images = (value: unknown): JsonObject[] => {
  if (Array.isArray(value)) return value.flatMap(images);
  if (!value || typeof value !== "object") return [];
  const block = value as JsonObject;
  return block.type === "image" ? [block] : Object.values(block).flatMap(images);
};

test("real stdio MCP images are normalized before history and survive a cold next turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "lxe-mcp-images-"));
  const workspace = resolveWorkspaceContext(root);
  const manager = new McpManager({ servers: [{
    name: "fixture", enabled: true, transport: "stdio", command: process.execPath,
    args: [join(import.meta.dir, "../tooling/image-mcp-server.fixture.ts")], env: {}, cwd: root,
    url: "", headers: {}, envHeaders: {}, bearerTokenEnvVar: "", connectorId: "fixture", connectorName: "Fixture", connectorDescription: "",
    startupTimeoutMs: 5_000, toolTimeoutMs: 5_000, enabledTools: new Set(), disabledTools: new Set(), exposure: "direct",
  }] });
  const tools = new ToolRegistry();
  let store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
  let count = 0;
  const requests: RuntimeMessage[][] = [], streams: unknown[] = [];
  const createRuntime = () => new TypeScriptAgentRuntime({ permissionPolicy: new PermissionPolicyService(), store, tools, systemPrompt: "test", provider: {
    summarize: async () => { throw new Error("unexpected summary"); },
    turn: async request => {
      requests.push(structuredClone(request.messages));
      return count++ === 0 ? messageFixture({ stopReason: "toolUse", content: [{ type: "tool_call", id: "capture", name: "mcp__fixture__screenshot", arguments: {} }] })
        : messageFixture({ content: [{ type: "text", text: "done" }] });
    },
  }, emitter: { emit: async () => {}, typing: async () => {}, desktopStream: async batch => { streams.push(batch); } } });
  const job = (turn: string): AgentJob => ({ job_id: turn, session_id: "s1", session_key: "s1", response_route_id: "r1", user_id: "u1", conversation_id: "c1", is_group: false, message_id: turn, user_input: "capture", job_kind: "turn", sender_nick: "test", source: { platform: "desktop" }, raw_data: {}, user_content_blocks: [], diagnostics: [], workspace });
  const handle = { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} };
  let runtime = createRuntime();
  try {
    await manager.start(tools);
    expect(manager.status("fixture").connected).toBe(true);
    await runtime.start();
    await store.ensureSession({ session_id: "s1", source: { platform: "desktop" }, workspace });
    expect((await runtime.runTurn(job("t1"), handle)).status).toBe("completed");
    const saved = await store.loadMessages("s1");
    const retained = images(saved);
    expect(retained).toHaveLength(1);
    const source = retained[0]!.source as JsonObject;
    expect(source.media_type).toBe("image/png");
    expect(String(source.data).length).toBeLessThan(4.5 * 1024 * 1024);
    expect(await new Bun.Image(Buffer.from(String(source.data), "base64")).metadata()).toMatchObject({ width: 2000, height: 1 });
    const serialized = JSON.stringify(saved);
    expect(serialized).toContain("original 6000x2, displayed at 2000x1");
    expect(serialized).toContain("x coordinates by 3.0000 and y coordinates by 2.0000");
    expect(serialized).toContain("Tool image 2 omitted:");
    expect(serialized).toContain("Page title: fixture");
    expect(serialized).toContain("[MCP structured content]\\nfalse");
    expect(serialized).not.toContain("YWJj");
    expect(images(requests[1])).toEqual(retained);
    expect(JSON.stringify(streams)).not.toContain(String(source.data));
    expect(JSON.stringify(await store.sessionDetail("s1", { limit: 10 }))).not.toContain(String(source.data));
    const transcript = await readFile(join(root, "session_transcripts", "s1.jsonl"), "utf8");
    expect(transcript).not.toContain('"kind":"image_view"');
    await runtime.stop();
    store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
    runtime = createRuntime();
    await runtime.start();
    expect((await runtime.runTurn(job("t2"), handle)).status).toBe("completed");
    expect(images(requests.at(-1))).toEqual(retained);
    expect(JSON.stringify(requests.at(-1))).toContain("[MCP structured content]\\nfalse");
  } finally {
    await runtime.stop();
    await manager.stop();
    await removeTemporaryRoot(root);
  }
}, 15_000);
