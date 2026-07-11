import type { JsonObject } from "@lxe/protocol";
import { ToolRegistry } from "./tools";

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
    execute: async (input) => {
      const terms = String(input.query ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
      if (terms.length === 0) throw new Error("tool_search query must contain a specific capability");
      const limit = Math.max(1, Math.min(Number(input.limit ?? 8), 20));
      const matches = registry.schemas().filter((tool) => tool.name !== "tool_search").map((tool) => {
        const haystack = `${tool.name} ${tool.description} ${JSON.stringify(tool.input_schema)}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { tool, score };
      }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name)).slice(0, limit);
      const payload: JsonObject = {
        query: String(input.query ?? ""),
        tools: matches.map(({ tool }) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  });
}
