import { expect, test } from "bun:test";
import { adaptMcpTools, ToolRegistry, type McpServerConfig, type ToolDefinition } from "@lxe/runtime";
import { policyFor, testWorkspace } from "../../../packages/agent/runtime/test/workspace";
import { AgentRunHandle } from "../src/run-handle";
import { registerMcpDiscoveryTools } from "../src/mcp-discovery";
import { takeDesktopMcpConfig } from "../src/desktop-mcp";

const desktopConfig = () => takeDesktopMcpConfig({
  LXE_DESKTOP_MCP_COMMAND: "node", LXE_DESKTOP_MCP_SCRIPT: "server.js",
  LXE_DESKTOP_MCP_PIPE: "pipe", LXE_DESKTOP_MCP_TOKEN: "test",
})!;

function setup() {
  const registry = new ToolRegistry();
  registerMcpDiscoveryTools(registry, { servers: [desktopConfig()] });
  const handle = new AgentRunHandle();
  const makeTool = (name: string, options: Partial<ToolDefinition> = {}) => registry.register({
    name, description: "desktop example", input_schema: { type: "object" },
    source: "mcp", connectorName: "lxe_desktop", platforms: ["desktop"],
    execute: async () => ({ content: [] }), ...options,
  });
  const run = (code: string) => registry.execute("codemode", { code }, {
    platform: "desktop", exposureState: registry.createExposureState({ platform: "desktop", allowedSkills: new Set() }),
    handle, session_id: "s1", turn_id: "t1", tool_call_id: "call",
    workspace: testWorkspace, executionPolicy: policyFor(testWorkspace.directory),
  });
  return { registry, makeTool, run, handle };
}

test("script search and calls respect tool source, exposure, skill and platform", async () => {
  const { registry, makeTool, run } = setup();
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

test("discovery entries reflect enabled server modes and platform on each step of a turn", () => {
  const registry = new ToolRegistry();
  const desktop = desktopConfig();
  const user: McpServerConfig = { ...desktop, name: "user", platforms: ["desktop", "cli"], exposure: "direct" };
  registerMcpDiscoveryTools(registry, { servers: [desktop, user] });
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

test("cancelling a turn aborts an in-flight script tool with its desktop identity", async () => {
  const { makeTool, run, handle } = setup();
  const started = Promise.withResolvers<string | undefined>();
  const aborted = Promise.withResolvers<void>();
  makeTool("wait", { async execute(_args, context) {
    started.resolve(context.tool_call_id);
    context.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
    await aborted.promise;
    return { content: [] };
  } });
  const outcome = run("await tools.wait({})").then(() => "completed", () => "cancelled");
  expect(await started.promise).toBe("call/1");
  await handle.abort();
  await aborted.promise;
  expect(await outcome).toBe("cancelled");
});

test("codemode dispatches colliding JavaScript aliases to the exact registered tools", async () => {
  const { makeTool, run } = setup();
  const names = ["mcp__my-shop__get", "mcp__my_shop__get"];
  for (const name of names) makeTool(name, { execute: async () => ({ content: [{ type: "text", text: name }] }) });
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
  const { makeTool, run } = setup();
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
  const { registry, run } = setup();
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
