import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceContext } from "@lxe/core";
import type { AgentJob } from "@lxe/protocol";
import { TypeScriptAgentRuntime } from "../../src/engine/runtime";
import type { RuntimeMessage } from "../../src/engine/types";
import { PermissionPolicyService } from "../../src/permissions/policy";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { McpManager } from "../../src/tooling/mcp";
import { ToolRegistry } from "../../src/tooling/registry";
import { messageFixture } from "../message-fixtures";
import { removeTemporaryRoot } from "../temp-directory";

for (const errorKind of ["failure", "protocolError"]) {
  test(`real MCP ${errorKind} retains redacted diagnostics and truncation markers in model history`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lxe-mcp-error-"));
    const workspace = resolveWorkspaceContext(root);
    const manager = new McpManager({ servers: [{
      name: "fixture", enabled: true, transport: "stdio", command: process.execPath,
      args: [join(import.meta.dir, "../tooling/protocol-mcp-server.fixture.ts"), "modern"], env: {}, cwd: root,
      url: "", headers: {}, envHeaders: {}, bearerTokenEnvVar: "", connectorId: "fixture", connectorName: "Fixture", connectorDescription: "",
      startupTimeoutMs: 5_000, toolTimeoutMs: 5_000, enabledTools: new Set(), disabledTools: new Set(), exposure: "direct",
    }] });
    const tools = new ToolRegistry();
    const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
    const requests: RuntimeMessage[][] = [];
    const runtime = new TypeScriptAgentRuntime({ permissionPolicy: new PermissionPolicyService(), store, tools, systemPrompt: "test", provider: {
      summarize: async () => { throw new Error("unexpected summary"); },
      turn: async request => {
        requests.push(structuredClone(request.messages));
        return requests.length === 1 ? messageFixture({ stopReason: "toolUse", content: [{
          type: "tool_call", id: "failed-call", name: "mcp__fixture__echo", arguments: { [errorKind]: true },
        }] }) : messageFixture({ content: [{ type: "text", text: "observed failure" }] });
      },
    }, emitter: { emit: async () => {}, typing: async () => {} } });
    const job: AgentJob = { job_id: "t1", session_id: "s1", session_key: "s1", response_route_id: "r1", user_id: "u1", conversation_id: "c1", is_group: false, message_id: "t1", user_input: "test", job_kind: "turn", sender_nick: "test", source: { platform: "desktop" }, raw_data: {}, user_content_blocks: [], diagnostics: [], workspace };
    const handle = { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} };
    try {
      await manager.start(tools);
      expect(manager.status("fixture").connected).toBe(true);
      await runtime.start();
      await store.ensureSession({ session_id: "s1", source: { platform: "desktop" }, workspace });
      expect((await runtime.runTurn(job, handle)).status).toBe("completed");
      expect(requests).toHaveLength(2);
      for (const messages of [requests[1], await store.loadMessages("s1")]) {
        const serialized = JSON.stringify(messages);
        expect(serialized).toContain('"is_error":true');
        expect(serialized).toContain("actual upstream rejection");
        expect(serialized).toContain("chars omitted");
        expect(serialized).toContain("end-of-error");
        expect(serialized).toContain("[redacted]");
        expect(serialized).not.toContain("private-value");
      }
    } finally {
      await runtime.stop();
      await manager.stop();
      await removeTemporaryRoot(root);
    }
  });
}
