import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlias, isMap, parseDocument, stringify } from "yaml";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Retire the former bundled connector before generic MCP loading can connect it.
 * This product migration belongs to the host, not the Runtime's MCP connector.
 * Keep the original file privately backed up and respect later explicit edits.
 */
export function retireLegacySaihuMcp(path: string, stateRoot: string): boolean {
  let target: string;
  try { target = realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const key = createHash("sha256").update(target).digest("hex").slice(0, 24);
  const directory = join(stateRoot, "migrations");
  const marker = join(directory, `retire-saihu-mcp-v1-${key}.json`);
  if (existsSync(marker)) {
    const completed = JSON.parse(readFileSync(marker, "utf8")) as { version?: unknown; config_path?: unknown };
    if (completed?.version !== 1 || completed.config_path !== target) throw new Error(`Invalid MCP retirement marker: ${marker}`);
    return false;
  }
  const source = readFileSync(target, "utf8");
  const document = parseDocument(source);
  if (document.errors.length) throw document.errors[0];
  const root = record(document.toJS());
  if (!root) return false;
  const rootKey = root.mcpServers != null ? "mcpServers" : "servers";
  const servers = record(root[rootKey]);
  const server = record(servers?.["lxe-saihu"]);
  if (!servers || !server) return false;
  const alreadyDisabled = server.enabled === false;
  let updated = source;
  if (!alreadyDisabled) {
    const serversNode = document.get(rootKey, true);
    const serverNode = isMap(serversNode) ? serversNode.get("lxe-saihu", true) : undefined;
    const enabledNode = isMap(serverNode) ? serverNode.get("enabled", true) : undefined;
    if (isMap(serversNode) && !serversNode.anchor && isMap(serverNode) && !serverNode.anchor
      && !isAlias(enabledNode) && !(enabledNode as { anchor?: string } | undefined)?.anchor) {
      serverNode.set("enabled", false);
      updated = document.toString();
    } else {
      // Detach shared YAML mappings so disabling this entry cannot change another server.
      updated = stringify({ ...root, [rootKey]: { ...servers, "lxe-saihu": { ...server, enabled: false } } });
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backup = marker.replace(/\.json$/, ".yaml.bak");
  try { writeFileSync(backup, source, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  const markerTemporary = `${marker}.${randomUUID()}.tmp`;
  try {
    if (!alreadyDisabled) {
      writeFileSync(temporary, updated, { encoding: "utf8", mode: statSync(target).mode & 0o777, flag: "wx" });
      if (readFileSync(target, "utf8") !== source) throw new Error("MCP configuration changed during retirement; retry before starting MCP");
      renameSync(temporary, target);
    }
    writeFileSync(markerTemporary, JSON.stringify({ version: 1, config_path: target, backup_path: backup }) + "\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(markerTemporary, marker);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(markerTemporary, { force: true });
  }
  return true;
}
