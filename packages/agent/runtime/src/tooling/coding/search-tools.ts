import type { JsonObject, WorkspaceContext } from "@lxe/protocol";
import type { ToolDefinition } from "../registry";
import { WorkspaceSearchService } from "../workspace-search";
import type { CodingPathPolicy, ReadableTarget } from "./path-policy";
import { directoryListSchema, listDirectory, validateDirectoryListInput } from "./directory-list";
import { grepSchema, validateGrepInput } from "./grep-input";

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
      description: "Search UTF-8 files at any path readable by the local LXE Agent process. Relative paths resolve from the session working directory. pattern is a regular expression by default; set literal=true to search copied text without regex escaping. A literal LF requires multiline=true. Defaults to file names; use output_mode=content for matching lines or count for counts. head_limit defaults to 100 output lines, including context. before_context/after_context override context on that side, including zero; context only applies to content mode.",
      input_schema: grepSchema,
      execute: async (input, context) => {
        const args = validateGrepInput(input);
        const target = paths.resolveReadable(context.workspace, args.path);
        const output = await searchFor(target, context).grep({
          pattern: args.pattern,
          searchPath: target.path,
          outputMode: args.output_mode,
          glob: args.glob,
          fileType: args.type,
          literal: args.literal,
          caseInsensitive: args.case_insensitive,
          ...(args.context === undefined ? {} : { context: args.context }),
          ...(args.before_context === undefined ? {} : { beforeContext: args.before_context }),
          ...(args.after_context === undefined ? {} : { afterContext: args.after_context }),
          multiline: args.multiline,
          limit: args.head_limit,
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
      description: "List one directory level, including hidden entries, at any path readable by the local LXE Agent process. Relative paths resolve from the session working directory. Names are sorted case-insensitively with original-name tie breaking; directories end in /, symbolic links in @, and control characters are escaped. limit defaults to 500, offset to 0. Output contains complete entries within the character budget; use the returned next offset to continue. Each call reads a fresh directory listing: additions or removals between pages may cause omissions or duplicates.",
      input_schema: directoryListSchema,
      execute: async (input, context) => {
        const args = validateDirectoryListInput(input);
        const target = paths.resolveReadable(context.workspace, args.path);
        return { content: textBlock(listDirectory(target.path, args, toolOutputLimit, context.handle.signal)) };
      },
    },
  ];
}
