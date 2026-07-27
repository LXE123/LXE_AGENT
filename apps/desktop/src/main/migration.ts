import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { migrateSaihuMcpDefault } from "@lxe/gateway/desktop";

const migrateMcpDefaults = (path: string): void => {
  if (!existsSync(path) || !statSync(path).isFile()) return;
  const source = readFileSync(path, "utf8");
  const migrated = migrateSaihuMcpDefault(source);
  if (!migrated || migrated === source) return;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, migrated, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

export function bootstrapDesktopState(mcpDefaultPath: string, dataRoot: string): void {
  const configRoot = join(dataRoot, "config");
  mkdirSync(configRoot, { recursive: true });
  const mcpTarget = join(configRoot, "mcp_servers.local.yaml");
  if (!existsSync(mcpTarget) && existsSync(mcpDefaultPath) && statSync(mcpDefaultPath).isFile()) {
    copyFileSync(mcpDefaultPath, mcpTarget, constants.COPYFILE_EXCL);
  }
  migrateMcpDefaults(mcpTarget);
  const connectorState = join(configRoot, "connector-states.local.json");
  if (!existsSync(connectorState)) writeFileSync(connectorState, "{}\n", "utf8");
}
