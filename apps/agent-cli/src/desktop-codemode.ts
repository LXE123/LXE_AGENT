import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { DESKTOP_MCP_NAME } from "@lxe/desktop-protocol";
import type { JsonObject } from "@lxe/protocol";
import type { ToolRegistry } from "@lxe/runtime";
import { extname, resolve } from "node:path";
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };

// The two build entrypoints share src/ as their root, so the embedded worker is a sibling.
const workerUrl = Bun.embeddedFiles.length
  ? "./codemode-worker.js"
  : new URL(`./codemode-worker${extname(import.meta.path)}`, import.meta.url);

export function registerDesktopCodemode(registry: ToolRegistry): void {
  registry.register({
    name: "codemode",
    platforms: ["desktop"],
    description: "Run JavaScript to discover and use connected desktop scheduled-task tools (lxe_desktop). " +
      "Use await searchTools(query) for matching names, descriptions and input schemas, or inspect ALL_TOOLS. " +
      "Call await tools[name](args) for a result with content blocks. Use return or text(value) to send selected data back.",
    input_schema: {
      type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false,
    },
    async execute(input, context) {
      if (typeof input.code !== "string" || !input.code.trim()) throw new Error("codemode requires JavaScript in code");
      const exposure = context.exposureState ?? registry.createExposureState(
        context.platform ? { platform: context.platform } : {},
      );
      const scope = exposure.forMcpServer(DESKTOP_MCP_NAME);
      let callIndex = 0;
      const sandbox = new CodemodeSandbox({
        wasm: loadQuickJSWasm(resolve(import.meta.dir, wasmPath)),
        workerUrl,
        timeoutMs: 60_000,
        memoryLimitBytes: 32 * 1024 * 1024,
        tools: scope.schemas().map(tool => ({
          name: tool.name,
          description: tool.description,
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
        globals: [{
          name: "searchTools",
          execute(query) {
            if (typeof query !== "string") throw new Error("searchTools expects a string");
            return scope.find(query);
          },
        }],
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
