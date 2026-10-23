import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveWorkspaceContext } from "@lxe/core";
import type { AgentJob } from "@lxe/protocol";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { AtomicRuntimeProviderManager } from "../../src/providers/provider";
import { TypeScriptAgentRuntime } from "../../src/engine/runtime";
import { PermissionPolicyService } from "../../src/permissions/policy";
import { ToolRegistry } from "../../src/tooling/registry";
import type { RuntimeHandle, RuntimeModelSelection } from "../../src/engine/types";
import { messageFixture } from "../message-fixtures";

test("keeps every model request in a running turn fixed and restores independent choices after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-turn-model-"));
  const workspace = resolveWorkspaceContext(root);
  const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
  const initial: RuntimeModelSelection = { provider: "deepseek", model: "deepseek-v4-flash", credential_source: "local", effort: "low", thinking_enabled: true };
  const next: RuntimeModelSelection = { ...initial, model: "deepseek-v4-pro", effort: "high" };
  const environment = { AGENT_LLM_PROVIDER: initial.provider, AGENT_LLM_MODEL: initial.model, AGENT_LLM_THINKING_EFFORT: initial.effort, DEEPSEEK_API: "fixture-key" };
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const requests: Array<{ model: string; effort: string }> = [];
  const manager = new AtomicRuntimeProviderManager(repositoryRoot(import.meta.dir), environment, descriptor => ({
    summarize: async () => ({ text: "summary", usage: { input_tokens: 0, output_tokens: 0 } }),
    turn: async () => {
      requests.push({ model: descriptor.model, effort: descriptor.thinkingEffort });
      if (requests.length === 1) {
        started.resolve(); await release.promise;
        return messageFixture({ stopReason: "toolUse", content: [{ type: "tool_call", id: "noop-1", name: "noop", arguments: {} }] });
      }
      return messageFixture({ content: [{ type: "text", text: "done" }] });
    },
  }));
  const tools = new ToolRegistry();
  let toolsExecuted = 0;
  tools.register({ name: "noop", description: "fixture", input_schema: { type: "object", properties: {} }, execute: async () => { toolsExecuted++; return { content: [] }; } });
  const runtime = new TypeScriptAgentRuntime({ store, tools, providerManager: manager, systemPrompt: "test",
    permissionPolicy: new PermissionPolicyService(), emitter: { emit: async () => {}, typing: async () => {} } });
  const makeJob = (session_id: string, job_id: string): AgentJob => ({ session_id, job_id, session_key: session_id, response_route_id: "",
    user_id: "u", conversation_id: session_id, is_group: false, message_id: job_id, user_input: "hello", job_kind: "turn", sender_nick: "Tester",
    source: { platform: "cli" }, raw_data: {}, user_content_blocks: [], diagnostics: [], workspace });
  const handle = (): RuntimeHandle => ({ signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} });
  let running: ReturnType<typeof runtime.runTurn> | undefined;
  try {
    await runtime.start();
    for (const session_id of ["a", "b"]) {
      await store.ensureSession({ session_id, workspace, source: {} });
      await store.setSessionModelSelection(session_id, initial);
    }
    running = runtime.runTurn(makeJob("a", "first"), handle());
    await Promise.race([started.promise, running.then(() => { throw new Error("turn ended before the first model request"); })]);
    await store.setSessionModelSelection("a", next, 1);
    await manager.reconfigure({ model: next.model, thinkingEffort: next.effort });
    release.resolve();
    expect((await running).status).toBe("completed");
    expect(requests).toEqual([{ model: initial.model, effort: "low" }, { model: initial.model, effort: "low" }]);
    expect(toolsExecuted).toBe(1);
    expect((await store.getSession("a"))?.model_selection).toEqual(next);
    await runtime.stop(); await runtime.start();
    expect((await runtime.runTurn(makeJob("b", "second"), handle())).status).toBe("completed");
    expect((await runtime.runTurn(makeJob("a", "third"), handle())).status).toBe("completed");
    expect(requests.slice(2)).toEqual([{ model: initial.model, effort: "low" }, { model: next.model, effort: "high" }]);
  } finally {
    release.resolve();
    try { await running; } finally {
      await runtime.stop(); rmSync(root, { recursive: true, force: true });
    }
  }
});
