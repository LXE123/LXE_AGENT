import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { JsonObject } from "@lxe/protocol";
import { registerToolSearch, ToolExecutionError, type McpConfig, type SqliteRuntimeStore, type ToolRegistry } from "@lxe/runtime";
import { extname, resolve } from "node:path";
import { createCodemodeCatalog, toScriptValue } from "./codemode-catalog";
import { mcpServerEnabledOnPlatform } from "./mcp-server-directory";
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };

// The two build entrypoints share src/ as their root, so the embedded worker is a sibling.
const workerUrl = Bun.embeddedFiles.length
  ? "./codemode-worker.js"
  : new URL(`./codemode-worker${extname(import.meta.path)}`, import.meta.url);

export function registerMcpDiscoveryTools(
  registry: ToolRegistry,
  config: McpConfig,
  transcript: Pick<SqliteRuntimeStore, "readCodemodeStore" | "appendCodemodeStore">,
): void {
  const hasEnabledServer = (mode: "codemode" | "deferred", platform: string | undefined) => config.servers.some(server =>
    server.exposure === mode && mcpServerEnabledOnPlatform(server, platform));
  registerToolSearch(registry, platform => hasEnabledServer("deferred", platform));
  registry.register({
    name: "codemode",
    availableOn: platform => hasEnabledServer("codemode", platform),
    description: "Run JavaScript that combines connected MCP tools and local read, ls, grep, and edit in a QuickJS sandbox. Top-level await and return work. " +
      "Use await searchTools(query, { limit?, namespace? }) to find tools by capability, await describeTool(name) for a TypeScript declaration, " +
      "or await describeNamespace(name) for server information and tool names. ALL_TOOLS lists callable tools. " +
      "Call await tools[name](args). Local tools return text; read returns file text or an image {type, data, mimeType, note} suitable for image(). " +
      "Read a file before editing it. Edits take effect immediately and use the same permissions as a direct edit. " +
      "MCP tools return content, optional structuredContent and isError. " +
      "Check isError for server-reported tool errors; a failed connection rejects the call. " +
      "Use store(key, value) and load(key) to keep small JSON values across successful calls on this chat branch. " +
      "A missing key loads as undefined. Use store(key, undefined) to delete a key. " +
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
      const catalog = createCodemodeCatalog(scope.callableTools());
      const signal = context.signal ? AbortSignal.any([context.signal, context.handle.signal]) : context.handle.signal;
      const store = await transcript.readCodemodeStore(context.session_id);
      signal.throwIfAborted();
      let callIndex = 0;
      const sandbox = new CodemodeSandbox({
        wasm: loadQuickJSWasm(resolve(import.meta.dir, wasmPath)),
        workerUrl,
        timeoutMs: 60_000,
        memoryLimitBytes: 32 * 1024 * 1024,
        tools: catalog.entries.map(({ tool, jsName, description }) => ({
          name: tool.name, jsName, description,
          async execute(args, { signal }) {
            if (args === null || typeof args !== "object" || Array.isArray(args)) {
              throw new Error(`${tool.name} expects an arguments object`);
            }
            try {
              const result = await registry.execute(tool.name, args as JsonObject, {
                ...context, exposureState: scope, signal,
                ...(context.tool_call_id ? { tool_call_id: `${context.tool_call_id}/${++callIndex}` } : {}),
              });
              return toScriptValue(tool, result);
            } catch (error) {
              if (error instanceof ToolExecutionError && tool.source === "native") throw new Error(error.modelContent());
              throw error;
            }
          },
        })),
        globals: catalog.globals,
      });
      try {
        const result = await sandbox.execute(input.code, { signal, store });
        if (!result.ok) throw new Error(result.error.message);
        const content: JsonObject[] = result.output.map(item => item.type === "text"
          ? { type: "text", text: item.text }
          : { type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } });
        if (result.value !== undefined) content.push({
          type: "text", text: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
        });
        await transcript.appendCodemodeStore(context.session_id, context.turn_id, {
          set: result.storeWrites.set as JsonObject, delete: result.storeWrites.delete,
        }, signal);
        return { content };
      } finally {
        await sandbox.close();
      }
    },
  });
}
