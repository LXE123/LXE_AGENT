import { existsSync, statSync } from "node:fs";
import type { JsonObject } from "@lxe/protocol";
import type { ToolDefinition } from "../registry";
import type { CodingPathPolicy } from "./path-policy";

const textBlock = (text: string): JsonObject[] => [{ type: "text", text }];

export interface SendFileToolDependencies {
  paths: CodingPathPolicy;
  sendFile?: (request: { path: string; session_id: string; response_route_id: string }) => Promise<void>;
}

export function createSendFileTool(dependencies: SendFileToolDependencies): ToolDefinition {
  const { paths } = dependencies;
  return {
    name: "send_file",
    description: "Send an existing workspace/runtime artifact or a bundled skill asset to the current user.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async (input, context) => {
      const target = paths.resolveReadable(context.workspace, input.path);
      const path = target.path;
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`file not found: ${input.path}`);
      paths.assertSendable(context.workspace, target);
      if (dependencies.sendFile) {
        await dependencies.sendFile({
          path,
          session_id: context.session_id,
          response_route_id: context.response_route_id ?? "",
        });
      }
      return {
        content: textBlock(`Sent ${paths.displayReadablePath(context.workspace, target)}`),
        files: [path],
      };
    },
  };
}
