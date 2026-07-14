import type { JsonObject } from "@lxe/protocol";
import { ToolRegistry } from "./registry";

export function registerToolSearch(registry: ToolRegistry): void {
  registry.register({
    name: "tool_search",
    description: "Search available tools by capability, description, or parameter name.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } },
      required: ["query"],
      additionalProperties: false,
    },
    source: "native",
    exposure: "direct",
    execute: async (input, context) => {
      const limit = Math.max(1, Math.min(Number(input.limit ?? 8), 20));
      const exposure = context.exposureState ?? registry.createExposureState();
      const matches = exposure.search(String(input.query ?? ""), limit);
      const payload: JsonObject = {
        query: String(input.query ?? ""),
        tools: matches.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
        note: "Matched deferred tools are available from the next model step.",
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  });
}
