import { existsSync, statSync } from "node:fs";
import type { JsonObject, WorkspaceContext } from "@lxe/protocol";
import type { ToolDefinition } from "../registry";
import type { CodingPathPolicy, ReadableTarget } from "./path-policy";

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];

export interface SendFilesToolDependencies {
  paths: CodingPathPolicy;
}

interface SendableFile {
  path: string;
  displayPath: string;
}

export function createSendFilesTool(dependencies: SendFilesToolDependencies): ToolDefinition {
  const { paths } = dependencies;
  return {
    name: "send_files",
    description: "Send one or more existing workspace/runtime artifacts or bundled skill assets to the current user.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          uniqueItems: true,
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      if (!Array.isArray(input.paths) || input.paths.length === 0) {
        throw new Error("paths must be a non-empty array of file paths");
      }

      const requestedPaths = input.paths.map((value, index) => {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`paths[${index}] must be a non-empty string`);
        }
        return value;
      });
      const sendableFiles = requestedPaths.map((requestedPath) => {
        const target = paths.resolveReadable(context.workspace, requestedPath);
        assertSendableFile(paths, context.workspace, target, requestedPath);
        return {
          path: target.path,
          displayPath: paths.displayReadablePath(context.workspace, target),
        };
      });
      const uniqueFiles = uniqueByPath(sendableFiles);
      return {
        content: textBlock([
          `Sent ${uniqueFiles.length} ${uniqueFiles.length === 1 ? "file" : "files"}:`,
          ...uniqueFiles.map((file) => `- ${file.displayPath}`),
        ].join("\n")),
        files: uniqueFiles.map((file) => file.path),
      };
    },
  };
}

function assertSendableFile(
  paths: CodingPathPolicy,
  workspace: WorkspaceContext,
  target: ReadableTarget,
  requestedPath: string,
): void {
  if (!existsSync(target.path) || !statSync(target.path).isFile()) {
    throw new Error(`file not found: ${requestedPath}`);
  }
  paths.assertSendable(workspace, target);
}

function uniqueByPath(files: readonly SendableFile[]): SendableFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
