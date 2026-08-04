import { readdirSync } from "node:fs";
import type { JsonObject, WorkspaceContext } from "@lxe/protocol";
import type { ToolDefinition } from "../registry";
import { WorkspaceSearchService } from "../workspace-search";
import type { CodingPathPolicy, ReadableTarget } from "./path-policy";

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const inputText = (input: JsonObject, key: string): string => String(input[key] ?? "");

const truncateHeadTail = (value: string, limit: number): { value: string; truncated: boolean } => {
  if (value.length <= limit) return { value, truncated: false };
  const marker = `\n... (truncated, ${value.length} chars total) ...\n`;
  const available = Math.max(2, limit - marker.length);
  const head = Math.floor(available / 2);
  return { value: `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`, truncated: true };
};

export interface SearchToolDependencies {
  paths: CodingPathPolicy;
  toolOutputLimit: number;
  ripgrepPath?: string | null;
}

export function createSearchTools(dependencies: SearchToolDependencies): ToolDefinition[] {
  const { paths, toolOutputLimit } = dependencies;
  const searchOptions = dependencies.ripgrepPath === undefined
    ? {}
    : { ripgrepPath: dependencies.ripgrepPath };
  const externalSearches = new Map<string, WorkspaceSearchService>();
  const searchFor = (
    target: ReadableTarget,
    context: { workspace: WorkspaceContext; workspaceSearch?: WorkspaceSearchService },
  ): WorkspaceSearchService => {
    if (target.scope.kind === "workspace" && context.workspaceSearch) return context.workspaceSearch;
    const key = paths.normalizedScopeKey(target);
    let search = externalSearches.get(key);
    if (!search) {
      search = new WorkspaceSearchService(target.scope.root, {
        ...searchOptions,
        absolutePaths: target.scope.kind !== "workspace",
      });
      externalSearches.set(key, search);
      if (externalSearches.size > 8) externalSearches.delete(externalSearches.keys().next().value!);
    }
    return search;
  };

  return [
    {
      name: "grep",
      description: "Search UTF-8 files at any path readable by the local LXE Agent process for a regular expression. Relative paths resolve from the session working directory.",
      input_schema: { type: "object", properties: {
        pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, type: { type: "string" },
        output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
        case_insensitive: { type: "boolean" }, context: { type: "integer" }, before_context: { type: "integer" },
        after_context: { type: "integer" }, multiline: { type: "boolean" }, head_limit: { type: "integer" },
      }, required: ["pattern"], additionalProperties: false },
      execute: async (input, context) => {
        const target = paths.resolveReadable(context.workspace, input.path ?? ".");
        const pattern = inputText(input, "pattern");
        if (!pattern) throw new Error("pattern 不能为空");
        const maxLines = Math.max(1, Number(input.head_limit ?? 100));
        const mode = String(input.output_mode ?? "files_with_matches");
        if (!["files_with_matches", "content", "count"].includes(mode)) throw new Error(`未知 output_mode: ${mode}`);
        const output = await searchFor(target, context).grep({
          pattern,
          searchPath: target.path,
          outputMode: mode as "files_with_matches" | "content" | "count",
          glob: inputText(input, "glob"),
          fileType: inputText(input, "type"),
          caseInsensitive: input.case_insensitive === true,
          ...(input.context === undefined ? {} : { context: Math.max(0, Number(input.context)) }),
          ...(input.before_context === undefined ? {} : { beforeContext: Math.max(0, Number(input.before_context)) }),
          ...(input.after_context === undefined ? {} : { afterContext: Math.max(0, Number(input.after_context)) }),
          multiline: input.multiline === true,
          limit: maxLines,
          signal: context.handle.signal,
        });
        return { content: textBlock(truncateHeadTail(output, toolOutputLimit).value) };
      },
    },
    {
      name: "find",
      description: "Find files at any path readable by the local LXE Agent process using a glob-like pattern. Relative paths resolve from the session working directory.",
      input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, head_limit: { type: "integer" } }, required: ["pattern"], additionalProperties: false },
      execute: async (input, context) => {
        const target = paths.resolveReadable(context.workspace, input.path ?? ".");
        const pattern = inputText(input, "pattern");
        if (!pattern) throw new Error("pattern 不能为空");
        const max = Math.max(1, Number(input.head_limit ?? 200));
        const output = await searchFor(target, context).find({
          pattern,
          searchPath: target.path,
          limit: max,
          signal: context.handle.signal,
        });
        return { content: textBlock(truncateHeadTail(output, toolOutputLimit).value) };
      },
    },
    {
      name: "ls",
      description: "List any directory readable by the local LXE Agent process. Relative paths resolve from the session working directory.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      execute: async (input, context) => {
        const target = paths.resolveReadable(context.workspace, input.path ?? ".");
        const listing = readdirSync(target.path, { withFileTypes: true })
          .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
          .sort();
        return { content: textBlock(truncateHeadTail(listing.join("\n"), toolOutputLimit).value) };
      },
    },
  ];
}
