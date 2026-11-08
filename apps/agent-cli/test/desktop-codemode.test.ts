import { expect, test } from "bun:test";
import { ToolRegistry, type ToolDefinition } from "@lxe/runtime";
import { policyFor, testWorkspace } from "../../../packages/agent/runtime/test/workspace";
import { AgentRunHandle } from "../src/run-handle";
import { registerDesktopCodemode } from "../src/desktop-codemode";

function setup() {
  const registry = new ToolRegistry();
  registerDesktopCodemode(registry);
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

test("script search and calls only reach currently allowed desktop MCP tools", async () => {
  const { registry, makeTool, run } = setup();
  makeTool("visible");
  makeTool("mcp__lxe_desktop__lookalike", { connectorName: "other" });
  makeTool("native", { source: "native" });
  makeTool("private_tool", { ownerSkills: ["private"] });
  expect(registry.createExposureState({ platform: "feishu" }).schemas()).toEqual([]);
  const result = await run(`
    return { search: (await searchTools("desktop")).map(t => t.name), callable: Object.keys(tools) };
  `);
  expect(JSON.parse(String(result.content[0]?.text))).toEqual({ search: ["visible"], callable: ["visible"] });
  registry.unregisterWhere(name => name === "visible");
  expect((await run('return await searchTools("desktop")')).content[0]?.text).toBe("[]");
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
