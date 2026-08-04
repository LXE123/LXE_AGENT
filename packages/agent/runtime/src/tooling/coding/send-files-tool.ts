import { statSync } from "node:fs";
import type { JsonObject } from "@lxe/protocol";
import type { ToolDefinition } from "../registry";
import type { CodingPathPolicy } from "./path-policy";

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];
const isMissingPathError = (cause: unknown): boolean =>
  cause instanceof Error
  && "code" in cause
  && (cause.code === "ENOENT" || cause.code === "ENOTDIR");

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
    description: "Send one or more existing regular files readable by the local LXE Agent process to the current user.",
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
        let info: ReturnType<typeof statSync>;
        try {
          info = statSync(target.path);
        } catch (cause) {
          if (!isMissingPathError(cause)) throw cause;
          throw new Error(`file not found: ${requestedPath}`);
        }
        if (!info.isFile()) throw new Error(`file not found: ${requestedPath}`);
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

function uniqueByPath(files: readonly SendableFile[]): SendableFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
