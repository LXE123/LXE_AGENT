import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { JsonObject } from "@lxe/protocol";
import { registerToolSearch, type McpConfig, type ToolRegistry } from "@lxe/runtime";
import { extname, resolve } from "node:path";
import { createCodemodeCatalog } from "./codemode-catalog";
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };

// The two build entrypoints share src/ as their root, so the embedded worker is a sibling.
const workerUrl = Bun.embeddedFiles.length
  ? "./codemode-worker.js"
  : new URL(`./codemode-worker${extname(import.meta.path)}`, import.meta.url);

export function registerMcpDiscoveryTools(registry: ToolRegistry, config: McpConfig): void {
  const hasEnabledServer = (mode: "codemode" | "deferred", platform: string | undefined) => config.servers.some(server =>
    server.enabled && server.exposure === mode && (!server.platforms || server.platforms.includes(platform ?? "")));
  registerToolSearch(registry, platform => hasEnabledServer("deferred", platform));
  registry.register({
    name: "codemode",
    availableOn: platform => hasEnabledServer("codemode", platform),
    description: "Run JavaScript that calls connected MCP tools in a QuickJS sandbox. Top-level await and return work. " +
      "Use await searchTools(query, { limit?, namespace? }) to find tools by capability, await describeTool(name) for a TypeScript declaration, " +
      "or await describeNamespace(name) for server information and tool names. ALL_TOOLS lists callable tools. " +
      "Call await tools[name](args) for an MCP result with content, optional structuredContent and isError. " +
      "Check isError for server-reported tool errors; a failed connection rejects the call. " +
      "Use return, text(value), or image(block) to show selected output.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string", description: "Raw JavaScript source." } },
      required: ["code"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (typeof input.code !== "string" || !input.code.trim()) throw new Error("codemode requires JavaScript in code");
      const exposure = context.exposureState ?? registry.createExposureState(
        context.platform ? { platform: context.platform } : {},
      );
      const scope = exposure.forCodemode();
      const catalog = createCodemodeCatalog(scope.callableTools(), config);
      let callIndex = 0;
      const sandbox = new CodemodeSandbox({
        wasm: loadQuickJSWasm(resolve(import.meta.dir, wasmPath)),
        workerUrl,
        timeoutMs: 60_000,
        memoryLimitBytes: 32 * 1024 * 1024,
        tools: catalog.entries.map(({ tool, jsName, description }) => ({
          name: tool.name, jsName, description,
          execute(args, { signal }) {
            if (args === null || typeof args !== "object" || Array.isArray(args)) {
              throw new Error(`${tool.name} expects an arguments object`);
            }
            return registry.execute(tool.name, args as JsonObject, {
              ...context, exposureState: scope, signal,
              ...(context.tool_call_id ? { tool_call_id: `${context.tool_call_id}/${++callIndex}` } : {}),
            });
          },
        })),
        globals: catalog.globals,
      });
      try {
        const result = await sandbox.execute(input.code, { signal: context.handle.signal });
        if (!result.ok) throw new Error(result.error.message);
        const content: JsonObject[] = result.output.map(item => item.type === "text"
          ? { type: "text", text: item.text }
          : { type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } });
        if (result.value !== undefined) content.push({
          type: "text", text: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
        });
        return { content };
      } finally {
        await sandbox.close();
      }
    },
  });
}
