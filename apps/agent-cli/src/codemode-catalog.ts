import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { JsonObject } from "@lxe/protocol";
import { createToolSearchDocument, rankDocuments, type NormalizedToolDefinition, type ToolExecutionResult } from "@lxe/runtime";

// MCP result declaration adapted from Pi. See the MIT notice in runtime's tool-search-ranking.ts.
const CONTENT_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

/**
 * `schema` as a subschema at the JSON pointer `pointer` (`#/properties/structuredContent`) of
 * another schema: its local references (`#`, `#/$defs/Item`) are rewritten to point below
 * `pointer`, so they resolve to the same subschemas as before.
 */
function relocateSchema(schema: unknown, pointer: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
  if (typeof schema !== "object" || schema === null) return schema;
  const relocated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
      relocated[key] = `${pointer}${value.slice(1)}`;
    } else if (SCHEMA_DATA_KEYWORDS.has(key)) {
      relocated[key] = value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      relocated[key] = Object.fromEntries(
        Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
      );
    } else {
      relocated[key] = relocateSchema(value, pointer);
    }
  }
  return relocated;
}

/**
 * The MCP result a script receives, with the server's output schema nested under structuredContent.
 */
function createMcpResultSchema(structuredContentSchema: JsonObject | undefined): CodemodeJsonSchema {
  return {
    type: "object",
    properties: {
      content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
      // Servers may send structured content without declaring a schema for it, and it may be any JSON value.
      structuredContent: structuredContentSchema
        ? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
        : {},
      isError: { type: "boolean" },
    },
    required: ["content"],
    // Fields newer protocol versions add.
    additionalProperties: true,
  };
}

const textSchema = { type: "string" };
const readSchema = { anyOf: [textSchema, {
  type: "object", properties: {
    type: { const: "image" }, data: textSchema, mimeType: textSchema, note: textSchema,
  }, required: ["type", "data", "mimeType", "note"], additionalProperties: false,
}] };

function scriptResultSchema(tool: NormalizedToolDefinition) {
  if (tool.source === "mcp") return createMcpResultSchema(tool.outputSchema);
  if (typeof tool.codemodeResult === "object") return tool.codemodeResult;
  return tool.codemodeResult === "text-or-image" ? readSchema : textSchema;
}

export function toScriptValue(tool: NormalizedToolDefinition, result: ToolExecutionResult) {
  if (tool.source === "mcp") return result;
  if (typeof tool.codemodeResult === "object") {
    if (result.structuredContent === undefined) throw new TypeError(`${tool.name} returned no structured result`);
    return result.structuredContent;
  }
  const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  if (tool.codemodeResult === "text-or-image") {
    const block = result.content.find(block => block.type === "image");
    if (block) {
      const source = block.source;
      if (!source || typeof source !== "object" || Array.isArray(source) || source.type !== "base64"
        || typeof source.data !== "string" || typeof source.media_type !== "string") {
        throw new TypeError(`${tool.name} returned an invalid image block`);
      }
      return { type: "image", data: source.data, mimeType: source.media_type, note: text };
    }
  }
  return text;
}

/** One snapshot of the tools permitted in this script; discovery never activates a tool. */
export function createCodemodeCatalog(callable: NormalizedToolDefinition[]) {
  const aliasCounts = new Map<string, number>();
  for (const tool of callable) {
    const alias = toCodemodeIdentifier(tool.name);
    aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
  }
  const entries = callable.map(tool => {
    const alias = toCodemodeIdentifier(tool.name);
    // Preserve exact MCP names and choose an unambiguous alias when Pi's '_' spelling collides.
    const jsName = alias !== tool.name && aliasCounts.get(alias)! > 1
      ? tool.name.replaceAll("-", "$") : alias;
    const description = renderToolSample({
      name: jsName, description: tool.description, inputSchema: tool.input_schema,
      outputSchema: scriptResultSchema(tool),
    });
    const server = tool.connectorName;
    const namespace = server ? `mcp__${server}` : undefined;
    const summary = tool.connectorDescription;
    const instructions = tool.connectorInstructions;
    return {
      tool, jsName, description, server, namespace, summary, instructions,
      document: createToolSearchDocument(tool),
    };
  });
  const byName = new Map(entries.flatMap(entry => [[entry.tool.name, entry], [entry.jsName, entry]] as const));
  const inNamespace = (name: string) => {
    const exact = entries.filter(entry => entry.server === name || entry.namespace === name);
    if (exact.length) return exact;
    const id = toCodemodeIdentifier(name);
    return entries.filter(entry => entry.server && entry.namespace &&
      (toCodemodeIdentifier(entry.server) === id || toCodemodeIdentifier(entry.namespace) === id));
  };

  const globals: CodemodeTool[] = [
    { name: "searchTools", spread: true, execute(args) {
      const [query, options] = args as [unknown, { limit?: unknown; namespace?: unknown }?];
      if (typeof query !== "string") throw new Error("searchTools() expects a query string");
      const limit = options?.limit ?? 8;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) throw new Error("searchTools() limit must be a positive integer");
      const namespace = options?.namespace;
      if (namespace != null && typeof namespace !== "string") throw new Error("searchTools() namespace must be a string");
      const matches = namespace ? inNamespace(namespace) : entries;
      return rankDocuments(query, matches.map(entry => entry.document), limit).map(name => {
        const entry = byName.get(name)!;
        return { name: entry.jsName, description: entry.description };
      });
    } },
    { name: "describeTool", execute(name) {
      if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
      return byName.get(name)?.description;
    } },
    { name: "describeNamespace", execute(name) {
      if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
      const matches = inNamespace(name);
      const first = matches[0];
      if (!first) return undefined;
      return { name: first.namespace, ...(first.summary ? { description: first.summary } : {}),
        ...(first.instructions ? { instructions: first.instructions } : {}), tools: matches.map(entry => entry.jsName) };
    } },
  ];
  return { entries, globals };
}
