import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptMcpTools, ExecutionPaths, PermissionApprovalService, registerCodingTools, SqliteRuntimeStore, ToolOutputError, ToolRegistry, type McpServerConfig, type ToolDefinition } from "@lxe/runtime";
import { policyFor, testWorkspace, workspaceFor } from "../../../packages/agent/runtime/test/workspace";
import { AgentRunHandle } from "../src/run-handle";
import { registerMcpDiscoveryTools } from "../src/mcp-discovery";
import { takeDesktopMcpConfig } from "../src/desktop-mcp";

const desktopConfig = () => takeDesktopMcpConfig({
  LXE_DESKTOP_MCP_COMMAND: "node", LXE_DESKTOP_MCP_SCRIPT: "server.js",
  LXE_DESKTOP_MCP_PIPE: "pipe", LXE_DESKTOP_MCP_TOKEN: "test",
})!;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(servers: McpServerConfig[] = [desktopConfig()]) {
  const root = mkdtempSync(join(tmpdir(), "lxe-codemode-store-"));
  const transcript = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
  cleanups.push(async () => { await transcript.stop(); rmSync(root, { recursive: true, force: true }); });
  await transcript.start();
  await transcript.ensureSession({ session_id: "s1", source: {}, workspace: testWorkspace });
  const registry = new ToolRegistry();
  registerMcpDiscoveryTools(registry, { servers }, transcript);
  const handle = new AgentRunHandle();
  const makeTool = (name: string, options: Partial<ToolDefinition> = {}) => registry.register({
    name, description: "desktop example", input_schema: { type: "object" },
    source: "mcp", connectorName: "lxe_desktop", connectorDescription: desktopConfig().connectorDescription, platforms: ["desktop"],
    execute: async () => ({ content: [] }), ...options,
  });
  const run = (code: string, sessionId = "s1", turnId = "t1") => registry.execute("codemode", { code }, {
    platform: "desktop", exposureState: registry.createExposureState({ platform: "desktop", allowedSkills: new Set() }),
    handle, session_id: sessionId, turn_id: turnId, tool_call_id: "call",
    workspace: testWorkspace, executionPolicy: policyFor(testWorkspace.directory),
  });
  return { registry, makeTool, run, handle, transcript, root };
}

test("script search and calls respect tool source, exposure, skill and platform", async () => {
  const { registry, makeTool, run } = await setup();
  makeTool("visible");
  makeTool("hidden_tool", { exposure: "hidden" });
  makeTool("unrelated_platform", { platforms: ["feishu"] });
  makeTool("other_server", { connectorName: "other", exposure: "deferred" });
  makeTool("native", { source: "native" });
  makeTool("private_tool", { ownerSkills: ["private"] });
  expect(registry.createExposureState({ platform: "feishu" }).schemas()).toEqual([]);
  const result = await run(`
    return { search: (await searchTools("desktop")).map(t => t.name), callable: Object.keys(tools) };
  `);
  expect(JSON.parse(String(result.content[0]?.text))).toEqual({ search: ["visible", "other_server"], callable: ["visible", "other_server"] });
  registry.unregisterWhere(name => name === "visible" || name === "other_server");
  expect((await run('return await searchTools("desktop")')).content[0]?.text).toBe("[]");
});

test("discovery entries reflect enabled server modes and platform on each step of a turn", async () => {
  const desktop = desktopConfig();
  const user: McpServerConfig = { ...desktop, name: "user", platforms: ["desktop", "cli"], exposure: "direct" };
  const { registry } = await setup([desktop, user]);
  const desktopTurn = registry.createExposureState({ platform: "desktop" });
  const cliTurn = registry.createExposureState({ platform: "cli" });
  const names = (state: typeof cliTurn) => state.schemas().map(tool => tool.name).sort();
  expect(desktop.exposure).toBe("codemode");
  expect(names(desktopTurn)).toEqual(["codemode"]);
  expect(names(cliTurn)).toEqual([]);
  user.exposure = "deferred";
  expect(names(desktopTurn)).toEqual(["codemode", "tool_search"]);
  expect(names(cliTurn)).toEqual(["tool_search"]);
  user.enabled = false;
  expect(names(desktopTurn)).toEqual(["codemode"]);
  expect(cliTurn.isExposed("tool_search")).toBe(false);
  desktop.enabled = false;
  expect(names(desktopTurn)).toEqual([]);
  user.enabled = true;
  user.exposure = "hidden";
  expect(names(desktopTurn)).toEqual([]);
});

test("scripts expose native tools with their script signatures and can forward a read image", async () => {
  const { registry, run } = await setup();
  const processes = registerCodingTools(registry, {});
  cleanups.push(() => processes.stop());
  const result = await run(`
    const entries = ALL_TOOLS.map(({name}) => name).sort();
    const read = await describeTool("read");
    const edit = (await searchTools("edit")).find(t => t.name === "edit").description;
    const photo = await tools.read({path: ${JSON.stringify(join(import.meta.dir, "../../../packages/agent/runtime/test/fixtures/color-pattern.jpg"))}});
    image(photo);
    return {entries, read, edit, note: photo.note};
  `);
  expect(result.content[0]).toMatchObject({ type: "image", source: { type: "base64", data: expect.any(String), media_type: expect.stringMatching(/^image\//) } });
  const info = JSON.parse(String(result.content[1]?.text));
  expect(info.entries).toEqual(["edit", "exec", "grep", "ls", "read", "wait", "write"]);
  expect(info.read).toContain("mimeType: string");
  expect(info.edit).toContain("Promise<string>");
  expect(info.note).toContain("Read image file");
});

test("scripts write files and inspect structured foreground, yielded and terminated commands", async () => {
  const { registry, root, handle, transcript } = await setup();
  const processes = registerCodingTools(registry, { executionPaths: new ExecutionPaths(root) });
  cleanups.unshift(() => processes.stop());
  const context = { platform: "desktop", session_id: "s1", turn_id: "t1", tool_call_id: "script", handle,
    workspace: workspaceFor(root), executionPolicy: policyFor(root) };
  const run = async (code: string, sessionId = "s1") => {
    const result = await registry.execute("codemode", { code }, { ...context, session_id: sessionId });
    return JSON.parse(String(result.content[0]?.text));
  };
  const fixture = `const fs = require("node:fs");
    if (process.argv[2] === "long") {
      process.stdout.write("first\\n");
      const timer = setInterval(() => { if (fs.existsSync("finish")) {
        clearInterval(timer); process.stdout.write("second\\n"); process.exitCode = 7;
      } }, 10);
    } else { process.stdout.write("  result\\n"); process.exitCode = 3; }`;
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" command.cjs`;
  expect(await run(`return {message: await tools.write({file_path:"command.cjs",content:${JSON.stringify(fixture)}})}`))
    .toEqual({ message: "Wrote command.cjs" });
  const short = await run(`return await tools.exec({command:${JSON.stringify(command)}})`);
  expect(short).toMatchObject({ status: "failed", exit_code: 3, output: "  result\n" });
  const clipped = await run(`return await tools.exec({command:${JSON.stringify(command)}, "max-output-tokens":1})`);
  expect(clipped).toMatchObject({ observation_truncated: true, output_file_covers_captured: true, exit_code: 3 });
  expect(readFileSync(clipped.output_path, "utf8")).toBe("  result\n");
  const launch = `await tools.exec({command:${JSON.stringify(command + " long")}, "yield-time-ms":250})`;
  const first = await run(`const r = ${launch}; store("job",r.exec_id); return r;`);
  expect(first.status).toBe("running");
  expect(first.exec_id).toStartWith("exec_");
  await transcript.ensureSession({ session_id: "other", source: {}, workspace: context.workspace });
  await expect(run(`return await tools.wait({exec_id:${JSON.stringify(first.exec_id)},terminate:true})`, "other"))
    .rejects.toThrow("不存在或已经关闭");
  const last = await run(`await tools.write({file_path:"finish",content:""}); return await tools.wait({exec_id:load("job")});`);
  expect(last).toMatchObject({ exec_id: first.exec_id, status: "failed", exit_code: 7 });
  expect(first.output + last.new_output).toBe("first\nsecond\n");
  await expect(run('return await tools.wait({exec_id:load("job")})')).rejects.toThrow("不存在或已经关闭");
  rmSync(join(root, "finish"));
  const killed = await run(`const r = ${launch}; return await tools.wait({exec_id:r.exec_id,terminate:true});`);
  expect(killed.status).toBe("killed");
  const same = await run(`const r = ${launch};
    await tools.write({file_path:"finish",content:""});
    const done = await tools.wait({exec_id:r.exec_id});
    return [r.status, done.exit_code, r.output + done.new_output];`);
  expect(same).toEqual(["running", 7, "first\nsecond\n"]);
});

test("nested write and exec cannot bypass the current session's approval", async () => {
  const { root, registry, handle } = await setup();
  let pending = Promise.withResolvers<void>();
  const approvals = new PermissionApprovalService({ audit: async () => {}, changed: () => pending.resolve() });
  const processes = registerCodingTools(registry, { approvals, executionPaths: new ExecutionPaths(root) });
  cleanups.unshift(async () => { await approvals.stop(); await processes.stop(); });
  const context = { platform: "desktop", session_id: "s1", turn_id: "t1", tool_call_id: "script", handle,
    workspace: workspaceFor(root), executionPolicy: { ...policyFor(root), mode: "read-only" as const } };
  writeFileSync(join(root, "order.txt"), "original");
  const run = (code: string) => registry.execute("codemode", { code }, context);
  await run('await tools.read({path:"order.txt"})');
  const write = { file_path: "order.txt", content: "changed" };
  await expect(run(`await tools.write(${JSON.stringify(write)})`)).rejects.toThrow("read-only mode");
  for (const [name, args] of [["write", write], ["exec", {command:"echo changed"}]] as const) {
    pending = Promise.withResolvers<void>();
    const outcome = run(`await tools.${name}(${JSON.stringify({ ...args, sandbox_permissions: "danger-full-access", justification: "Approval test" })})`)
      .then(() => "succeeded", err => String(err));
    await pending.promise;
    const [request] = approvals.snapshot();
    expect(request).toMatchObject({ tool: name, tool_call_id: "script/1", session_id: "s1" });
    await approvals.decide({ session_id: "s1", request_id: request!.request_id, decision: "deny" });
    expect(await outcome).toContain("User denied");
  }
  expect(readFileSync(join(root, "order.txt"), "utf8")).toBe("original");
  expect(processes.snapshots("s1")).toEqual([]);
});

test("nested edit shares file versions with direct read and enforces denials and script cancellation", async () => {
  const { registry, root, handle } = await setup();
  let pending = Promise.withResolvers<void>();
  const approvals = new PermissionApprovalService({ audit: async () => {}, changed: () => pending.resolve() });
  const processes = registerCodingTools(registry, { approvals });
  cleanups.push(async () => { await approvals.stop(); await processes.stop(); });
  const file = join(root, "order.txt");
  writeFileSync(file, "ready");
  const context = { platform: "desktop", session_id: "s1", turn_id: "t1", tool_call_id: "call", handle,
    workspace: workspaceFor(root), executionPolicy: { ...policyFor(root), mode: "workspace-write" as const },
  };
  const args = { path: "order.txt", edits: [{ oldText: "ready", newText: "edited" }] };
  const edit = `await tools.edit(${JSON.stringify(args)})`;
  const run = (code: string, mode: "read-only" | "workspace-write", signal?: AbortSignal) => registry.execute("codemode", { code }, {
    ...context, executionPolicy: { ...context.executionPolicy, mode }, ...(signal ? { signal } : {}),
  });
  await expect(run(edit, "workspace-write")).rejects.toThrow("请先用 read");
  await registry.execute("read", { path: "order.txt" }, context);
  writeFileSync(file, "ready from another editor");
  await expect(run(edit, "workspace-write")).rejects.toThrow("请重新 read");
  await run('await tools.read({path:"order.txt"})', "read-only");
  await expect(run(edit, "read-only")).rejects.toThrow("read-only mode does not allow file writes");
  const elevated = `await tools.edit(${JSON.stringify({ ...args, sandbox_permissions: "workspace-write", justification: "Update order" })})`;
  for (const action of ["deny", "cancel"]) {
    pending = Promise.withResolvers<void>();
    const controller = new AbortController();
    const outcome = run(elevated, "read-only", controller.signal).then(() => "succeeded", err => String(err));
    await pending.promise;
    const [request] = approvals.snapshot();
    expect(request).toMatchObject({ tool: "edit", tool_call_id: "call/1", arguments: { edits: args.edits } });
    if (action === "deny") {
      await approvals.decide({ session_id: "s1", request_id: request!.request_id, decision: "deny" });
      expect(await outcome).toContain("User denied");
    } else {
      controller.abort();
      expect(await outcome).not.toBe("succeeded");
      expect(handle.signal.aborted).toBe(false);
    }
    expect(approvals.snapshot()).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("ready from another editor");
  }
  await registry.execute("edit", args, context);
  expect(readFileSync(file, "utf8")).toBe("edited from another editor");
});

test("cancelling a turn aborts an in-flight script tool with its desktop identity", async () => {
  const { makeTool, run, handle, transcript } = await setup();
  const started = Promise.withResolvers<string | undefined>();
  const aborted = Promise.withResolvers<void>();
  makeTool("wait", { async execute(_args, context) {
    started.resolve(context.tool_call_id);
    context.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
    await aborted.promise;
    return { content: [] };
  } });
  await run('store("keep", 1)');
  const outcome = run('store("keep", undefined); store("unfinished", true); await tools.wait({})').then(() => "completed", () => "cancelled");
  expect(await started.promise).toBe("call/1");
  await handle.abort();
  await aborted.promise;
  expect(await outcome).toBe("cancelled");
  expect(await transcript.readCodemodeStore("s1")).toEqual({ keep: 1 });
});

test("codemode commits only successful script changes as internal transcript entries", async () => {
  const { run, transcript, root } = await setup();
  await transcript.appendMessage("s1", { role: "user", content: "hello" }, "turn_input", "t1");
  await run('store("ids", [1, 2]); store("metadata", { active: false }); store("ids", [...load("ids"), 3]);');
  await expect(run('store("ids", null); throw new Error("broken script")')).rejects.toThrow("broken script");
  expect((await run('return load("ids")')).content[0]?.text).toBe("[1,2,3]");
  await run('store("ids", undefined); store("metadata", null)');
  await transcript.stop();
  await transcript.start();
  expect((await run('return [load("ids") === undefined, load("metadata") === null]')).content[0]?.text).toBe("[true,true]");
  const rows = readFileSync(join(root, "session_transcripts", "s1.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row));
  const writes = rows.filter(row => row.kind === "codemode_store");
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ turn_id: "t1", set: { ids: [1, 2, 3], metadata: { active: false } }, delete: [] });
  expect(writes[1]).toMatchObject({ parent_id: writes[0].id, set: { metadata: null }, delete: ["ids"] });
  expect(await transcript.loadMessages("s1")).toHaveLength(1);
  expect((await transcript.loadTranscriptDisplayPage("s1", { limit: 10 })).messages).toHaveLength(1);
});

test("failed and timed-out scripts retain emitted blocks before the actual diagnostic", async () => {
  const { run, registry, makeTool, transcript } = await setup();
  const processes = registerCodingTools(registry, {});
  cleanups.push(() => processes.stop());
  const failure = await run(`
    text("orders checked");
    image(await tools.read({path:"packages/agent/runtime/test/fixtures/color-pattern.jpg"}));
    console.log("total computed");
    store("unfinished", true);
    throw Error("missing amount: token=private-value");
  `).catch(error => error);
  expect(failure).toBeInstanceOf(ToolOutputError);
  expect(failure.content.map((item: { type: string }) => item.type)).toEqual(["text", "image", "text", "text"]);
  expect(failure.content[0].text).toBe("orders checked");
  expect(failure.content[2].text).toContain("total computed");
  const reason = failure.content[3].text;
  expect(reason).toContain("missing amount");
  expect(reason).not.toContain("private-value");
  expect(await transcript.readCodemodeStore("s1")).toEqual({});
  makeTool("hold", { async execute(_, { signal }) {
    await new Promise(resolve => signal!.addEventListener("abort", resolve, { once: true }));
    return { content: [] };
  } });
  const timeout = await run('// @options: {"timeout_ms":500}\ntext("started"); await tools.hold({})').catch(error => error);
  expect(timeout).toBeInstanceOf(ToolOutputError);
  expect(timeout.content[0].text).toBe("started");
  expect(timeout.content[1].text).toMatch(/timed out after 500 ms/i);
  await expect(run('// @options: {"timeout_ms":0}\nstore("invalid", true)')).rejects.toThrow("positive integer");
  expect(await transcript.readCodemodeStore("s1")).toEqual({});
});

test("script text spills at either budget, and the read tool can recover the omitted lines", async () => {
  const { run, registry } = await setup();
  const processes = registerCodingTools(registry, {});
  cleanups.push(() => processes.stop());
  for (const [options, line] of [
    ["", "汉".repeat(4) + "\n"], // Fits Pi's default character budget but exceeds the runtime's byte limit.
    ['// @options: {"max_output_tokens":20000}\n', "abcde\n"],
    ['// @options: {"max_output_tokens":0}\n', "xyz\n"],
  ] as const) {
    const repetitions = line.startsWith("汉") ? 4_000 : 8_000;
    const source = `"start\\n" + ${JSON.stringify(line)}.repeat(${repetitions}) + "end"`;
    const preview = String((await run(options + "return " + source)).content[0]?.text);
    const path = /\[Full output: (.+) \(read with offset\/limit\)\]/.exec(preview)?.[1];
    expect(path).toBeDefined();
    cleanups.push(async () => rmSync(path!, { force: true }));
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(40_000);
    expect(preview).toContain("tokens truncated");
    if (line === "xyz\n") expect(preview).not.toContain("xyz");
    else { expect(preview).toContain("start\n"); expect(preview).toContain("end"); }
    expect(readFileSync(path!, "utf8")).toBe("start\n" + line.repeat(repetitions) + "end");
    if (process.platform !== "win32") expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect((await run(`return await tools.read({path:${JSON.stringify(path)},offset:2,limit:1})`)).content[0]?.text)
      .toContain(line.trim());
  }
});

test("a fork inherits codemode values through its selected turn and writes independently", async () => {
  const { run, transcript } = await setup();
  const read = async (sessionId: string) => (await run('return load("id")', sessionId)).content[0]?.text;
  await run('store("id", "first")');
  await transcript.appendTurnEnd("s1", "t1", "completed");
  await run('store("id", "later")', "s1", "t2");
  await transcript.appendTurnEnd("s1", "t2", "cancelled");
  const fork = String((await transcript.forkSession("s1", "t1")).session_id);
  expect(await read(fork)).toBe("first");
  await transcript.ensureSession({ session_id: "unrelated", source: {}, workspace: testWorkspace });
  expect(await read("unrelated")).toBeUndefined();
  await run('store("id", "child")', fork, "t3");
  await transcript.replaceMessages(fork, [{ role: "user", content: "compacted history" }], "compaction");
  expect(await read("s1")).toBe("later");
  await transcript.deleteSession("s1");
  await transcript.stop();
  await transcript.start();
  expect(await read(fork)).toBe("child");
});

test("codemode dispatches colliding JavaScript aliases to the exact registered tools", async () => {
  const { registry, makeTool, run } = await setup();
  const names = ["mcp__my-shop__get", "mcp__my_shop__get"];
  for (const name of names) makeTool(name, { exposure: "direct", execute: async () => ({ content: [{ type: "text", text: name }] }) });
  const state = registry.createExposureState({ platform: "desktop" });
  const schemas = state.schemas();
  for (const name of names) {
    expect(schemas.find(tool => tool.name === name)?.description).toBe(
      `desktop example\n\nCodemode: \`tools.${name.replaceAll("-", "$")}(args)\` resolves to \`{ content, structuredContent?, isError? }\`.`,
    );
    expect(registry.definition(name)!.description).toBe("desktop example");
  }
  expect(state.schemas()).toEqual(schemas);
  const result = await run(`
    const hits = await searchTools("get");
    const call = async t => (await tools[t.name]({})).content[0].text;
    return [await Promise.all(hits.map(call)), await Promise.all(ALL_TOOLS.map(call))];
  `);
  const [found, listed] = JSON.parse(String(result.content[0]?.text)) as string[][];
  expect(found!.sort()).toEqual(names);
  expect(listed!.sort()).toEqual(names);
});

test("Pi discovery offers ranked callable names, signatures and scoped namespace information", async () => {
  const { makeTool, run } = await setup();
  const name = "mcp__lxe_desktop__list-widgets";
  const alias = "mcp__lxe_desktop__list_widgets";
  makeTool(name, {
    description: "List colorful widgets", connectorInstructions: "Desktop instructions",
    input_schema: { type: "object", required: ["owner"], properties: { owner: { $ref: "#/$defs/Owner" } },
      $defs: { Owner: { type: "string", description: "account responsible for inventory" } } },
    outputSchema: { $defs: { Row: { type: "number" } }, type: "array", items: { $ref: "#/$defs/Row" } },
  });
  makeTool("mcp__other__list_widgets", { connectorName: "other" });
  makeTool("secret", { exposure: "hidden" });
  const result = await run(`
    const [hit] = await searchTools("inventory", { namespace: "mcp__lxe_desktop", limit: 1 });
    const decl = await describeTool(hit.name);
    return {
      hit, same: decl === hit.description && decl === (await describeTool(${JSON.stringify(name)}))
        && decl === ALL_TOOLS.find(t => t.name === hit.name).description,
      ns: await describeNamespace("lxe_desktop"), empty: await searchTools("", { limit: 2 }),
      missing: (await describeTool("secret")) === undefined && (await describeNamespace("absent")) === undefined,
    };
  `);
  const value = JSON.parse(String(result.content[0]?.text));
  expect(value.hit.name).toBe(alias);
  expect(Object.keys(value.hit).sort()).toEqual(["description", "name"]);
  expect(value.hit.description).toContain("owner: string");
  expect(value.hit.description).toContain("Array<number>");
  expect(value.same).toBe(true);
  expect(value.missing).toBe(true);
  expect(value.empty).toEqual([]);
  expect(value.ns).toEqual({ name: "mcp__lxe_desktop", description: "管理桌面定时任务", instructions: "Desktop instructions", tools: [alias] });
  await expect(run('await searchTools("widget", { limit: 0 })')).rejects.toThrow("positive integer");
  await expect(run('await searchTools("widget", { namespace: 2 })')).rejects.toThrow("namespace must be a string");
});

test("scripts receive MCP content blocks and structured values, server errors resolve and transport errors reject", async () => {
  const { registry, run } = await setup();
  const image = { type: "image", data: "eA==", mimeType: "image/png" };
  const [tool] = adaptMcpTools(desktopConfig(), [{ name: "probe" }], async (_name, input) => {
    if (input.disconnect) throw new Error("transport closed during this call");
    if (input.fail) return { content: [{ type: "text", text: "actual failure token=private-value" }],
      isError: true, structuredContent: { code: 42 }, meta: { internal: "private" } };
    return { content: [image], structuredContent: input.value, meta: { private: true } };
  });
  registry.register(tool!);
  const result = await run(`
    const probe = tools.mcp__lxe_desktop__probe;
    const success = await Promise.all([null, false, 0, [], {items:[1]}].map(value => probe({value})));
    return { success, error: await probe({fail:true}) };
  `);
  const { success, error } = JSON.parse(String(result.content[0]?.text));
  expect(success).toEqual([null, false, 0, [], { items: [1] }].map(value => ({ content: [image], structuredContent: value })));
  expect(error.isError).toBe(true);
  expect(error.structuredContent).toEqual({ code: 42 });
  expect(error.content[0].text).toContain("actual failure");
  expect(JSON.stringify(error)).not.toContain("private");
  await expect(run("await tools.mcp__lxe_desktop__probe({disconnect:true})")).rejects.toThrow("transport closed during this call");
});

test("both searches rank the same MCP metadata, while only tool_search activates its hits", async () => {
  const { registry, makeTool } = await setup([{ ...desktopConfig(), exposure: "deferred" }, { ...desktopConfig(), name: "scripts" }]);
  const state = registry.createExposureState({ platform: "desktop" });
  makeTool("mcp__lxe_desktop__a", { description: "First line\ninvoice detail", exposure: "codemode" });
  makeTool("mcp__lxe_desktop__invoice", { description: "Best match\nPrivate second line", exposure: "deferred" });
  const context = {
    exposureState: state, handle: new AgentRunHandle(), session_id: "s1", platform: "desktop",
    workspace: testWorkspace, executionPolicy: policyFor(testWorkspace.directory),
  };
  const scriptSearch = async () => {
    const result = await registry.execute("codemode", { code: 'return (await searchTools("invoice")).map(t => t.name)' }, context);
    return JSON.parse(String(result.content[0]?.text));
  };
  const search = () => registry.execute("tool_search", { query: "invoice", limit: 1 }, context);
  const expected = ["mcp__lxe_desktop__invoice", "mcp__lxe_desktop__a"];
  expect(await scriptSearch()).toEqual(expected);
  expect(state.isExposed(expected[0]!)).toBe(false);
  expect((await search()).content[0]?.text).toBe("- mcp__lxe_desktop__invoice: Best match");
  expect((await search()).content[0]?.text).toBe("- mcp__lxe_desktop__a: First line");
  expect((await search()).content[0]?.text).toBe("No matching tools found.");
  expect(await scriptSearch()).toEqual(expected);
});
