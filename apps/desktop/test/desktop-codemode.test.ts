import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceContext } from "@lxe/core";
import { ProcessAgentRuntime, type DirectGatewayComposition } from "@lxe/gateway/desktop";
import { RunHandle } from "../../gateway/src/orchestration/scheduler";
import type { AgentJob } from "@lxe/protocol";
import deepseek from "../../../config/llm/providers/deepseek.json";
import { DesktopAutomations } from "../src/main/automations";
import { NodeAutomationStore } from "../src/main/automation-store";

const discovery = 'return (await searchTools("automation_runs")).map(tool => tool.name)';
const report = `
  const list = JSON.parse((await tools.mcp__lxe_desktop__automation_list({})).content[0].text);
  const errors = [];
  for (const task of list.items) {
    const runs = JSON.parse((await tools.mcp__lxe_desktop__automation_runs({ id: task.id })).content[0].text);
    for (const run of runs.items) if (run.dispatch_state === "failed") errors.push(run.error);
  }
  return errors;
`;

test.each(["compile", "build"] as const)("%s artifact discovers and calls desktop MCP with identical wire tools", async mode => {
  const root = mkdtempSync(join(tmpdir(), "lxe-codemode-"));
  const repo = resolve(import.meta.dir, "../../..");
  const executable = join(root, "agent-cli" + (process.platform === "win32" ? ".exe" : ""));
  const bundleDir = join(root, "bundle");
  const requests: { tools: { function: { name: string } }[]; messages: { role: string; content: unknown }[] }[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as typeof requests[number];
    if (body.tools?.length) requests.push(body);
    const code = body.tools?.length ? [discovery, report][requests.length - 1] : undefined;
    const delta = code
      ? { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function",
        function: { name: "codemode", arguments: JSON.stringify({ code }) } }] }
      : { content: "done" };
    const chunk = (data: unknown, finish: string | null) => JSON.stringify({
      id: "test", object: "chat.completion.chunk", model: deepseek.default_model,
      choices: [{ index: 0, delta: data, finish_reason: finish }],
    });
    return new Response(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, code ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } });
  } });
  const db = new Database(":memory:");
  const store = new NodeAutomationStore(db as unknown as DatabaseSync);
  const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    TEMP: root, TMP: root, TMPDIR: root, LOCAL_LOGS_ENABLED: "0" };
  const workspace = resolveWorkspaceContext(root);
  const llmConfigRoot = join(root, "config", "llm");
  const job: AgentJob = { job_id: "turn", session_id: "chat", session_key: "chat", conversation_id: "chat",
    response_route_id: "route", user_id: "user", message_id: "message", is_group: false, job_kind: "turn",
    user_input: "List failed scheduled runs", sender_nick: "test", source: { platform: "desktop" },
    raw_data: {}, user_content_blocks: [], diagnostics: [], workspace };
  const handle = new RunHandle(job);
  const runtime = new ProcessAgentRuntime({
    ...(mode === "compile" ? { command: executable } : { command: process.execPath, arguments: [join(bundleDir, "main.js")] }),
    cwd: root, environment,
    skillsRoot: join(root, "skills"), userSkillsRoot: join(root, "user-skills"),
    dataRoot: root, llmConfigRoot, legacyWorkspace: workspace });
  const app = new DesktopAutomations({ store, runtime, environment, node: process.execPath,
    script: resolve(import.meta.dir, "../src/mcp/server.ts"), changed() {}, onError(error) { throw error; },
    composition: { parts: { scheduler: { activeRun: () => handle, runStatuses: () => [],
      isSessionDeletionFenced: () => false } } } as unknown as DirectGatewayComposition });
  try {
    const output = mode === "compile" ? ["--outfile", executable] : ["--outdir", bundleDir];
    const build = Bun.spawn([process.execPath, "run", `agent-cli:${mode}`, ...output],
      { cwd: repo, stdout: "ignore", stderr: "pipe" });
    const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (code !== 0) throw new Error(err);
    mkdirSync(join(root, "skills"));
    mkdirSync(join(llmConfigRoot, "providers"), { recursive: true });
    writeFileSync(join(llmConfigRoot, "providers", "deepseek.json"), JSON.stringify({
      ...deepseek, base_url: provider.url.origin, api_style: "openai_completions",
    }));
    writeFileSync(join(llmConfigRoot, "auth-profiles.json"), JSON.stringify({
      profiles: { deepseek: { type: "api_key", env_names: ["FIXTURE_KEY"], required: true } },
    }));
    writeFileSync(join(root, "config", "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "fixture" } }));
    await app.openPipe();
    await runtime.start();
    await runtime.ensureSession({ session_id: job.session_id, source: job.source, workspace });
    const task = await app.service.save({ definition: { name: "Check", prompt: "check", timezone: "UTC",
      target: { mode: "reuse", session_id: job.session_id }, schedule: { kind: "interval", minutes: 60 } } });
    expect(store.claim(task, task, { id: "failed-run", automation_id: task.id, automation_version: task.version,
      definition: task, trigger: "scheduled", nominal_at: 1, created_at: 1, accepted_at: null,
      session_id: job.session_id, turn_id: "failed-turn", dispatch_state: "failed", error: "fixture dispatch failure" })).toBe(true);
    expect((await runtime.runTurn(job, handle)).status).toBe("completed");
    expect(requests).toHaveLength(3);
    const names = requests[0]!.tools.map(tool => tool.function.name);
    expect(names).toContain("tool_search");
    expect(names).toContain("codemode");
    expect(names.some(name => name.startsWith("mcp__lxe_desktop__"))).toBe(false);
    for (const body of requests.slice(1)) expect(body.tools).toEqual(requests[0]!.tools);
    const lastToolOutput = (index: number) => requests[index]!.messages.filter(m => m.role === "tool").at(-1)?.content;
    expect(lastToolOutput(1)).toContain("mcp__lxe_desktop__automation_runs");
    expect(lastToolOutput(2)).toContain("fixture dispatch failure");
    expect(lastToolOutput(2)).not.toContain("failed-turn");
  } finally {
    await runtime.stop();
    await app.close();
    await provider.stop(true);
    db.close(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
