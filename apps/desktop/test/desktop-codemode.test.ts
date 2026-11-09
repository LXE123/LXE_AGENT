import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { desktopCodemodeReport } from "./fixtures/desktop-codemode-script";
import { runPiReference } from "./fixtures/pi-codemode-reference";

// Run this exact script against the packaged agent and (when supplied) the reference Pi CLI.
const discoverAndEdit = (dir: string) => `
  const path = ${JSON.stringify(join(dir, "orders.txt"))};
  const folder = ${JSON.stringify(dir)};
  const list = await tools.ls({path: folder});
  const hits = await tools.grep({path: folder, pattern: "pending"});
  if (!list.includes("orders.txt") || !hits.includes("orders.txt")) throw new Error("Cannot find orders.txt: " + hits);
  const before = await tools.read({path});
  if (before !== "  pending\\r\\n") throw new Error("Unexpected file contents: " + JSON.stringify(before));
  const summary = await tools.edit({path, edits: [{oldText: before.trim(), newText: "shipped"}]});
  if (typeof summary !== "string" || !summary || await tools.read({path}) !== "  shipped\\r\\n") throw new Error("Edit failed: " + summary);
  const photo = await tools.read({path: ${JSON.stringify(join(dir, "photo.jpg"))}});
  if (photo.type !== "image" || !photo.data || !photo.mimeType.startsWith("image/") || !photo.note) throw new Error("Invalid image result");
  const names = (await searchTools("automation_runs")).map(tool => tool.name);
  store("desktopTools", names);
  return names;
`;
const reportFromStore = `
  if (!load("desktopTools")?.includes("mcp__lxe_desktop__automation_runs")) throw new Error("Missing stored desktop tool");
  ${desktopCodemodeReport}
`;


test.each(["compile", "build"] as const)("%s artifact discovers and calls desktop MCP with identical wire tools", async mode => {
  const root = mkdtempSync(join(tmpdir(), "lxe-codemode-"));
  const repo = resolve(import.meta.dir, "../../..");
  const executable = join(root, "agent-cli" + (process.platform === "win32" ? ".exe" : ""));
  const bundleDir = join(root, "bundle");
  const files = join(root, "files");
  mkdirSync(files);
  copyFileSync(join(repo, "packages/agent/runtime/test/fixtures/color-pattern.jpg"), join(files, "photo.jpg"));
  const resetOrder = () => writeFileSync(join(files, "orders.txt"), "  pending\r\n");
  resetOrder();
  const discovery = discoverAndEdit(files);
  const nextCalls: { name: string; arguments: object }[] = [discovery, reportFromStore].map(code => ({ name: "codemode", arguments: { code } }));
  const requests: { tools: { function: { name: string } }[]; messages: { role: string; content: unknown }[] }[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as typeof requests[number];
    if (body.tools?.length) requests.push(body);
    const call = body.tools?.length ? nextCalls.shift() : undefined;
    const delta = call
      ? { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { content: "done" };
    const chunk = (data: unknown, finish: string | null) => JSON.stringify({
      id: "test", object: "chat.completion.chunk", model: deepseek.default_model,
      choices: [{ index: 0, delta: data, finish_reason: finish }],
    });
    return new Response(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, call ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`,
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
    const fixture = { command: process.execPath, args: [join(repo, "packages/agent/runtime/test/tooling/protocol-mcp-server.fixture.ts")] };
    writeFileSync(join(root, "config", "mcp_servers.local.json"), JSON.stringify({ servers: {
      reports: { ...fixture, enabled: false, exposure: "deferred" }, custom: { ...fixture, enabled: false },
    } }));
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
    expect(names).not.toContain("tool_search");
    expect(names).toContain("codemode");
    expect(names.some(name => name.startsWith("mcp__lxe_desktop__"))).toBe(false);
    for (const body of requests.slice(1)) expect(body.tools).toEqual(requests[0]!.tools);
    const lastToolOutput = (index: number) => requests[index]!.messages.filter(m => m.role === "tool").at(-1)?.content;
    expect(lastToolOutput(1)).toContain("mcp__lxe_desktop__automation_runs");
    expect(readFileSync(join(files, "orders.txt"), "utf8")).toBe("  shipped\r\n");
    expect(lastToolOutput(2)).toContain("fixture dispatch failure");
    expect(lastToolOutput(2)).not.toContain("failed-turn");

    const piCli = process.env.LXE_TEST_PI_CLI;
    if (piCli && mode === "build") {
      resetOrder();
      const start = requests.length;
      nextCalls.push(...[discovery, reportFromStore].map(code => ({ name: "codemode", arguments: { code } })));
      await runPiReference(piCli, root, provider.url.origin, environment, job.session_id, job.job_id);
      const piRequests = requests.slice(start);
      expect(piRequests).toHaveLength(3);
      expect(piRequests[0]!.tools.map(tool => tool.function.name)).toContain("codemode");
      for (const body of piRequests.slice(1)) expect(body.tools).toEqual(piRequests[0]!.tools);
      expect(lastToolOutput(start + 1)).toContain("mcp__lxe_desktop__automation_runs");
      expect(readFileSync(join(files, "orders.txt"), "utf8")).toBe("  shipped\r\n");
      expect(JSON.stringify(lastToolOutput(start + 2))).toContain("fixture dispatch failure");
    }

    const toggle = (name: string, enabled: boolean) => runtime.dashboardCall({ operation: "mcp.servers.update", input: { name, enabled } });
    const nextTurn = async (id: string, sessionId = job.session_id) => {
      const turn = { ...job, session_id: sessionId, session_key: sessionId, conversation_id: sessionId, message_id: id, job_id: id };
      const start = requests.length;
      expect((await runtime.runTurn(turn, new RunHandle(turn))).status).toBe("completed");
      return requests.slice(start).map(body => body.tools.map(tool => tool.function.name));
    };
    nextCalls.push({ name: "codemode", arguments: { code: `
      await tools.write({file_path:"codemode-note.txt", content:"from script"});
      const result = await tools.exec({command:"echo codemode-shell"});
      if (result.exit_code !== 0 || result.output.trim() !== "codemode-shell") throw new Error(JSON.stringify(result));
      if (!(await describeTool("wait")).includes("new_output")) throw new Error("Missing wait signature");
      return "script-command-ok";` } });
    expect(await nextTurn("script-command")).toHaveLength(2);
    expect(lastToolOutput(requests.length - 1)).toContain("script-command-ok");
    expect(readFileSync(join(root, "codemode-note.txt"), "utf8")).toBe("from script");
    expect(requests.at(-1)!.tools).toEqual(requests.at(-2)!.tools);
    await toggle("reports", true);
    nextCalls.push({ name: "tool_search", arguments: { query: "mcp__reports__echo", limit: 1 } });
    const mixed = await nextTurn("search-reports");
    expect(mixed).toHaveLength(2);
    expect(mixed[0]).toContain("codemode");
    expect(mixed[0]).toContain("tool_search");
    expect(mixed[0]).not.toContain("mcp__reports__echo");
    expect(mixed[1]).toContain("mcp__reports__echo");
    expect(lastToolOutput(requests.length - 1)).toContain("- mcp__reports__echo");
    expect(lastToolOutput(requests.length - 1)).not.toContain("input_schema");

    const forkAt = async (turn_id: string) => (await runtime.dashboardCall({
      operation: "sessions.fork", input: { session_id: job.session_id, turn_id },
    })).session_id;
    const beforeLoad = await forkAt(job.job_id);
    const afterLoad = await forkAt("search-reports");
    expect((await nextTurn("fork-before", beforeLoad))[0]).not.toContain("mcp__reports__echo");
    const resumed = await nextTurn("fork-after", afterLoad);
    expect(resumed[0]).toEqual(mixed[1]);
    nextCalls.push({ name: "tool_search", arguments: { query: "echo" } });
    const repeat = await nextTurn("search-again");
    expect(repeat[0]).toEqual(mixed[1]);
    expect(repeat[1]).toEqual(repeat[0]);
    expect(lastToolOutput(requests.length - 1)).toContain("No matching tools found.");

    await toggle("reports", false);
    await app.setMcpEnabled(false);
    const [empty] = await nextTurn("disabled");
    expect(empty).not.toContain("codemode");
    expect(empty).not.toContain("tool_search");
    expect(empty).not.toContain("mcp__reports__echo");
    await toggle("custom", true);
    nextCalls.push({ name: "codemode", arguments: { code: 'const [t] = await searchTools("mcp__custom__echo"); return (await tools[t.name]({})).content[0].text;' } });
    const custom = await nextTurn("custom-default");
    expect(custom).toHaveLength(2);
    expect(custom[0]).toContain("codemode");
    expect(custom[0]).not.toContain("tool_search");
    expect(custom[0]).not.toContain("mcp__custom__echo");
    expect(requests.at(-1)!.tools).toEqual(requests.at(-2)!.tools);
    expect(lastToolOutput(requests.length - 1)).toContain("fixture result");
  } finally {
    await runtime.stop();
    await app.close();
    await provider.stop(true);
    db.close(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
