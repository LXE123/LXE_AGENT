import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { SessionTitleService, fallbackSessionTitle, normalizeSessionTitle, titleFromOutput } from "../../src/state/session-title";
import type { RuntimeProviderRequest, AssistantMessage } from "../../src/engine/types";
import type { RuntimeProviderSnapshot } from "../../src/providers/provider";
import { messageFixture } from "../message-fixtures";
import { testWorkspace } from "../workspace";
import { removeTemporaryRoot } from "../temp-directory";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const response = (text = "Generated title") => messageFixture({ content: [{ type: "text", text }], stopReason: "stop" });
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(5); }
  throw new Error("title condition timed out");
};
async function fixture(turn: (request: RuntimeProviderRequest) => Promise<AssistantMessage> = async () => response(), timeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "lxe-titles-"));
  const path = join(root, "agent.sqlite3");
  const store = new SqliteRuntimeStore(path);
  await store.start();
  await store.ensureSession({ session_id: "s1", workspace: testWorkspace, source: {} });
  const changes: string[] = [];
  const errors: unknown[] = [];
  const service = new SessionTitleService({ store, onChanged: id => { changes.push(id); }, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    logger: { warn: (_name: string, details: unknown) => errors.push(details) } as never });
  cleanups.push(async () => { await service.stop(); await store.stop(); await removeTemporaryRoot(root); });
  const snapshot: RuntimeProviderSnapshot = { generation: 1, descriptor: {
    name: "captured-provider", model: "captured-model", apiStyle: "anthropic", apiKey: "secret-must-not-be-recorded", baseURL: "https://example.invalid",
    maxTokens: 32000, defaultHeaders: {}, thinkingStyle: "openai", thinkingLevels: ["low", "high"], thinkingDefault: "high",
    thinkingEnabled: true, thinkingEffort: "high", thinkingDisplay: "on", contextWindowTokens: 128000, requestIdleTimeoutMs: 120000,
  }, provider: { turn, summarize: async () => { throw Error("title must not use compaction prompt"); } } };
  const input = (text: string, id = "m1", original = text) => store.appendMessage("s1", { role: "user", content: text, message_id: id }, "turn_input", "t1", original);
  const events = () => readFileSync(join(root, "session_transcripts/s1.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { root, path, store, service, snapshot, changes, errors, input, events };
}

test("DSH title limits and normalization preserve UTF-8 code points", () => {
  expect(fallbackSessionTitle(" one two\n three four five six ")).toBe("one two three four five");
  expect(fallbackSessionTitle("中".repeat(20))).toBe("中".repeat(13));
  expect(normalizeSessionTitle("😀".repeat(21))).toBe("😀".repeat(20));
  expect(normalizeSessionTitle("\x1b]0;evil\x07\x1b[31m  Good\n title \u202e\u0000")).toBe("Good title");
  expect(normalizeSessionTitle("\u200b\x00")).toBe("");
  expect(titleFromOutput("\n **修复登录问题**\nexplanation")).toBe("修复登录问题");
  expect(titleFromOutput("***Title***")).toBe("Title");
});

test("first eligible human text gets fallback and only one non-blocking auxiliary call", async () => {
  let finish!: (message: AssistantMessage) => void;
  const requests: RuntimeProviderRequest[] = [];
  const f = await fixture(request => { requests.push(request); return new Promise(resolve => { finish = resolve; }); });
  await f.store.appendMessage("s1", { role: "user", content: [{ type: "image", data: "image" }] }, "turn_input", "images");
  await f.store.appendMessage("s1", { role: "user", content: "injected instructions" }, "environment_context");
  expect((await f.store.titleState("s1"))?.title).toBe("");
  await f.input("original with injected secret", "m1", "Fix the login button now please");
  expect((await f.store.titleState("s1"))?.title).toBe("Fix the login button now");
  expect(f.service.onMainRequest("s1", "m1", f.snapshot)).toBeUndefined();
  await until(() => requests.length === 1);
  expect(requests[0]).toMatchObject({ tools: [], toolChoice: "none", auxiliary: { maxOutputTokens: 4096, reasoning: "minimum" } });
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("secret");
  expect(JSON.stringify(requests[0]?.messages)).toContain("Fix the login button now please");
  await f.input("Later unrelated topic", "m2");
  f.service.onMainRequest("s1", "m2", f.snapshot);
  finish(response("**修复登录按钮**\nextra"));
  await until(async () => (await f.store.titleState("s1"))?.source === "provider");
  f.service.onMainRequest("s1", "m2", f.snapshot);
  await Bun.sleep(10);
  expect(requests).toHaveLength(1);
  const state = await f.store.titleState("s1");
  expect(state).toMatchObject({ title: "修复登录按钮", source: "provider", version: 2, attempted: true });
  expect(f.changes).toEqual(["s1"]);
  expect(f.events().filter(event => event.kind === "session_title_request")).toHaveLength(1);
  expect(JSON.stringify(f.events())).not.toContain("secret-must-not-be-recorded");
  expect((await f.store.loadMessages("s1"))).toHaveLength(4);
  const detail = await f.store.sessionDetail("s1", { limit: 100 });
  expect(JSON.stringify(detail?.messages)).not.toContain("session_title");
  expect((detail?.session as { input_tokens: number }).input_tokens).toBe(0);
});

test("manual title pins during generation even if provider ignores abort; identical/duplicate titles are accepted", async () => {
  let finish!: (message: AssistantMessage) => void;
  let request: RuntimeProviderRequest | undefined;
  const f = await fixture(r => { request = r; return new Promise(resolve => { finish = resolve; }); });
  await f.input("Original prompt");
  f.service.onMainRequest("s1", "m1", f.snapshot);
  await until(() => Boolean(request));
  await f.service.rename("s1", " 手动\n标题 ");
  expect(request?.signal.aborted).toBe(true);
  finish(response("Late unwanted title"));
  await Bun.sleep(10);
  expect(await f.store.titleState("s1")).toMatchObject({ title: "手动 标题", source: "user", version: 2 });
  await f.service.rename("s1", "手动 标题");
  expect((await f.store.titleState("s1"))?.version).toBe(3);
  await expect(f.service.rename("s1", "\u200b")).rejects.toThrow("visible text");
  f.store.registerWorkspace(testWorkspace.directory);
  const blank = f.store.createBlankSession(testWorkspace);
  await expect(f.service.rename(String(blank.session_id), "Name")).rejects.toThrow("empty session");
  await f.store.ensureSession({ session_id: "s2", workspace: testWorkspace, source: {} });
  await f.service.rename("s2", "手动 标题");
  expect((await f.store.titleState("s2"))?.title).toBe("手动 标题");
});

for (const [name, result] of [
  ["empty", response("\u200b")], ["length", { ...response(), stopReason: "length" as const }],
  ["tools", { ...response(), content: [{ type: "tool_call" as const, id: "tool", name: "forbidden", arguments: {} }] }],
  ["error", { ...response(), stopReason: "error" as const, error: { message: "HTTP 502 upstream failed" } }],
] satisfies Array<[string, AssistantMessage]>) test(`invalid ${name} output retains fallback and never retries automatically`, async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return result; });
  await f.input("Original prompt"); f.service.onMainRequest("s1", "m1", f.snapshot);
  await until(() => f.errors.length > 0);
  f.service.onMainRequest("s1", "m1", f.snapshot); await Bun.sleep(10);
  expect(calls).toBe(1);
  expect(await f.store.titleState("s1")).toMatchObject({ title: "Original prompt", source: "fallback", version: 1 });
  if (name === "error") expect(String((f.errors[0] as { error: Error }).error)).toContain("HTTP 502 upstream failed");
});

test("oversize framed input is rejected without truncation or a model request", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return response(); });
  await f.input("a".repeat(4096)); f.service.onMainRequest("s1", "m1", f.snapshot);
  await until(() => f.errors.length > 0);
  expect(calls).toBe(0); expect((await f.store.titleState("s1"))?.title).toBe("a".repeat(40));
});

test("timeout, deletion and shutdown stop auxiliary tasks without waiting for an uncooperative provider", async () => {
  const f = await fixture(() => new Promise(() => {}), 5);
  await f.input("First prompt"); f.service.onMainRequest("s1", "m1", f.snapshot);
  await until(() => f.errors.length > 0);
  expect((await f.store.titleState("s1"))?.source).toBe("fallback");
  const g = await fixture(() => new Promise(() => {}));
  await g.input("First prompt"); g.service.onMainRequest("s1", "m1", g.snapshot);
  await until(async () => (await g.store.titleState("s1"))?.attempted === true);
  g.service.cancel("s1"); await g.store.deleteSession("s1");
  await g.service.stop();
  expect(await g.store.titleState("s1")).toBeUndefined();
});

test("restart recovers append-before-projection failures and preserves legacy records", async () => {
  const f = await fixture(); await f.input("First prompt"); await f.service.rename("s1", "Pinned");
  await f.store.stop();
  appendFileSync(join(f.root, "session_transcripts/s1.jsonl"), JSON.stringify({ kind: "session_title", title: "Recovered", source: "user", version: 3 }) + "\n");
  await f.store.start();
  expect(await f.store.titleState("s1")).toMatchObject({ title: "Recovered", version: 3, source: "user" });
  await f.store.stop();
  const db = new Database(f.path);
  db.run("DELETE FROM transcript_file_state"); db.run("UPDATE agent_sessions SET title = '', title_version = 0, title_source = ''"); db.close();
  await f.store.start();
  expect((await f.store.titleState("s1"))?.title).toBe("Recovered");
  await f.store.stop();
  const legacy = new Database(f.path);
  legacy.run("UPDATE agent_sessions SET title = 'Existing title'");
  for (const name of ["title_source", "title_version", "title_input", "title_attempted", "title_automatic"]) legacy.exec(`ALTER TABLE agent_sessions DROP COLUMN ${name}`);
  legacy.close();
  // No title events existed in an actual pre-feature log.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(f.root, "session_transcripts/s1.jsonl"), JSON.stringify({ kind: "message", message: { role: "user", content: "Old prompt" } }) + "\n");
  await f.store.start(); await f.input("New prompt", "m2");
  expect(await f.store.titleState("s1")).toMatchObject({ title: "Existing title", source: "", automatic: false, version: 0 });
});

test("explicit refresh reuses first human text and only unpins after an accepted replacement", async () => {
  const f = await fixture(); await f.input("First prompt"); await f.service.rename("s1", "Manual");
  await f.service.refresh("s1", f.snapshot);
  expect(await f.store.titleState("s1")).toMatchObject({ title: "Generated title", source: "provider" });
  await f.service.rename("s1", "Manual again"); await f.service.refresh("s1");
  expect(await f.store.titleState("s1")).toMatchObject({ title: "First prompt", source: "fallback" });
});

test("runtime starts the title on the first main request, finishes chat independently, and excludes auxiliary usage", async () => {
  const { TypeScriptAgentRuntime } = await import("../../src/engine/runtime");
  const { ToolRegistry } = await import("../../src/tooling/registry");
  const { PermissionPolicyService } = await import("../../src/permissions/policy");
  const requests: RuntimeProviderRequest[] = []; let finish!: (message: AssistantMessage) => void;
  const f = await fixture(async request => {
    requests.push(request);
    if (request.auxiliary) return new Promise(resolve => { finish = resolve; });
    return messageFixture({ content: [{ type: "text", text: "Main answer" }], usage: { input_tokens: 7, output_tokens: 3 } });
  });
  await f.store.appendPendingEvent("s1", { text: "Private system event", event_id: "e1", job_id: "j1" });
  const runtime = new TypeScriptAgentRuntime({ store: f.store, sessionTitles: f.service,
    providerManager: { acquire: () => f.snapshot, reconfigure: async () => { throw Error("must not change settings"); } },
    permissionPolicy: new PermissionPolicyService(), tools: new ToolRegistry(), systemPrompt: "System instructions",
    emitter: { emit: async () => {}, typing: async () => {} }, maxSteps: 1,
  });
  await runtime.start();
  const result = await runtime.runTurn({ job_id: "j1", session_id: "s1", session_key: "agent:main:desktop:dm:c1", response_route_id: "r1",
    user_id: "u1", conversation_id: "c1", is_group: false, message_id: "m1", user_input: "Fix a bug", job_kind: "turn", sender_nick: "Tester",
    source: { platform: "desktop" }, raw_data: {}, user_content_blocks: [], diagnostics: [], workspace: testWorkspace,
  }, { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} });
  expect(result).toMatchObject({ status: "completed", reply: "Main answer", input_tokens: 7, output_tokens: 3 });
  await until(() => Boolean(finish));
  expect(requests.filter(request => request.auxiliary)).toHaveLength(1);
  expect(JSON.stringify(requests.find(request => request.auxiliary)?.messages)).not.toContain("Private system event");
  expect((await f.store.titleState("s1"))?.title).toBe("Fix a bug");
  finish(messageFixture({ content: [{ type: "text", text: "Fixed title" }], usage: { input_tokens: 999, output_tokens: 999 } }));
  await until(async () => (await f.store.titleState("s1"))?.title === "Fixed title");
  const item = f.store.listSessions({ limit: 10, offset: 0 }).items[0];
  expect(item).toMatchObject({ input_tokens: 7, output_tokens: 3, api_call_count: 1 });
  await runtime.stop();
});

test("manual name before the first human text stays pinned and a failed explicit refresh preserves it", async () => {
  const f = await fixture(async () => { throw new Error("HTTP 503 title service unavailable"); });
  await f.service.rename("s1", "Pinned early");
  await f.input("First real text");
  f.service.onMainRequest("s1", "m1", f.snapshot);
  await Bun.sleep(10);
  expect(await f.store.titleState("s1")).toMatchObject({ title: "Pinned early", source: "user", attempted: false });
  await expect(f.service.refresh("s1", f.snapshot)).rejects.toThrow("HTTP 503 title service unavailable");
  expect((await f.store.titleState("s1"))?.title).toBe("Pinned early");
  await f.service.refresh("s1");
  expect((await f.store.titleState("s1"))?.title).toBe("First real text");
});

test("a crash between the first input and its title does not retitle from the second prompt", async () => {
  let requests = 0;
  const f = await fixture(async () => { requests++; return response(); });
  await f.input("Original plus injected text", "m1", "Original human text");
  const events = f.events().filter(event => event.kind !== "session_title");
  await f.store.stop();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(f.root, "session_transcripts/s1.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const db = new Database(f.path);
  db.run("UPDATE agent_sessions SET title = '', title_source = '', title_version = 0, title_input = ''");
  db.run("DELETE FROM transcript_file_state"); db.close();
  await f.store.start();
  await f.input("Second prompt", "m2");
  expect(await f.store.titleState("s1")).toMatchObject({ title: "Original human text", input: { id: "m1", text: "Original human text" } });
  f.service.onMainRequest("s1", "m2", f.snapshot); await Bun.sleep(10);
  expect(requests).toBe(0);
});

test("standalone task titles share the tool-free provider request without touching session state", async () => {
  const { TaskTitleService } = await import("../../src/state/session-title");
  const requests: RuntimeProviderRequest[] = [];
  const f = await fixture(async request => { requests.push(request); return response("**运营日报**"); });
  const service = new TaskTitleService();
  try {
    expect(await service.generate("每天汇总运营数据", f.snapshot)).toBe("运营日报");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tools: [], toolChoice: "none", auxiliary: { maxOutputTokens: 4096, reasoning: "minimum" } });
    expect(requests[0]!.system).toContain("scheduled task");
    expect(requests[0]!.messages).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.messages)).toContain("每天汇总运营数据");
    expect((await f.store.titleState("s1"))?.title).toBe("");
    expect(await f.store.loadMessages("s1")).toHaveLength(0);
  } finally { await service.stop(); }
});

test("standalone title timeout and service shutdown abort the provider, including providers that ignore cancellation", async () => {
  const { TaskTitleService } = await import("../../src/state/session-title");
  let signal!: AbortSignal;
  const f = await fixture(async request => { signal = request.signal; return new Promise(() => {}); });
  const timed = new TaskTitleService(10);
  await expect(timed.generate("test", f.snapshot)).rejects.toThrow("timed out");
  expect(signal.aborted).toBe(true);
  const service = new TaskTitleService();
  const call = service.generate("test", f.snapshot);
  const rejected = call.catch(error => error);
  await service.stop(); expect(String(await rejected)).toContain("service stopped");
  expect(signal.aborted).toBe(true);
  await expect(service.generate("test", f.snapshot)).rejects.toThrow("service stopped");
});
