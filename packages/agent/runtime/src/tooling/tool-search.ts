import { ToolRegistry } from "./registry";

export function registerToolSearch(registry: ToolRegistry, availableOn?: (platform: string | undefined) => boolean): void {
  registry.register({
    name: "tool_search",
    description: "Search unloaded tools by capability with BM25. Matches are available for direct calls from the next model request on this chat branch.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, default: 8 } },
      required: ["query"],
      additionalProperties: false,
    },
    source: "native",
    exposure: "direct",
    ...(availableOn ? { availableOn } : {}),
    execute: async (input, context) => {
      const { query, limit = 8 } = input;
      if (typeof query !== "string" || !query.trim()) throw new Error("tool_search query must not be empty");
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) throw new Error("tool_search limit must be a positive integer");
      if (!context.exposureState) throw new Error("tool_search requires the current turn's tool exposure state");
      const matches = await context.exposureState.search(query, limit);
      const text = matches.length ? matches.map(tool => {
        const summary = tool.description.trim().split(/[\r\n]/u, 1)[0];
        return summary ? `- ${tool.name}: ${summary}` : `- ${tool.name}`;
      }).join("\n") : "No matching tools found.";
      return { content: [{ type: "text", text }] };
    },
  });
}
