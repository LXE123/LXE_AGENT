import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function bootstrapDesktopState(mcpDefaultPath: string, dataRoot: string): void {
  const configRoot = join(dataRoot, "config");
  mkdirSync(configRoot, { recursive: true });
  const mcpTarget = join(configRoot, "mcp_servers.local.yaml");
  if (!existsSync(mcpTarget) && existsSync(mcpDefaultPath) && statSync(mcpDefaultPath).isFile()) {
    copyFileSync(mcpDefaultPath, mcpTarget, constants.COPYFILE_EXCL);
  }
  const connectorState = join(configRoot, "connector-states.local.json");
  if (!existsSync(connectorState)) writeFileSync(connectorState, "{}\n", "utf8");
}
