import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadMcpConfig, McpManager, ToolRegistry } from "@lxe/runtime";
import { retireLegacySaihuMcp } from "../src/mcp-config-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(source?: string) {
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-retirement-")); roots.push(root);
  const path = join(root, "custom-mcp.yaml");
  if (source !== undefined) writeFileSync(path, source);
  return { root, path, migrations: join(root, "migrations") };
}
const original = `# User configuration
mcpServers:
  lxe-saihu:
    # Keep the endpoint and tool choices for a future explicit reconnection.
    enabled: true
    type: streamable-http
    url: http://127.0.0.1:1/mcp/
    bearer_token_env_var: REMOVED_COMPANY_KEY
    headers: {Authorization: "Bearer fixture-secret"}
    disabled_tools: [write]
    startup_timeout_s: 17
  other:
    enabled: true
    command: fixture-server
    args: [--example]
`;

test("retires the legacy connector before MCP startup without changing other servers", async () => {
  const f = fixture(original);
  expect(retireLegacySaihuMcp(f.path, f.root)).toBe(true);
  const saved = readFileSync(f.path, "utf8");
  const before = parse(original), after = parse(saved);
  expect(after.mcpServers["lxe-saihu"]).toEqual({ ...before.mcpServers["lxe-saihu"], enabled: false });
  expect(after.mcpServers.other).toEqual(before.mcpServers.other);
  expect(saved).toContain("# Keep the endpoint");
  const backup = join(f.migrations, readdirSync(f.migrations).find(name => name.endsWith(".yaml.bak"))!);
  expect(readFileSync(backup, "utf8")).toBe(original);
  if (process.platform !== "win32") expect(statSync(backup).mode & 0o777).toBe(0o600);
  const connected: string[] = [];
  const manager = new McpManager(loadMcpConfig(f.path, {}), { connect: async server => {
    connected.push(server.name);
    return { tools: [], callTool: async () => ({ content: [], isError: false }), close: async () => {} };
  } });
  try { await manager.start(new ToolRegistry()); expect(connected).toEqual(["other"]); }
  finally { await manager.stop(); }
});

test("migration runs once per configuration and preserves later explicit edits", () => {
  const f = fixture(original);
  retireLegacySaihuMcp(f.path, f.root);
  const snapshot = readFileSync(f.path, "utf8");
  expect(retireLegacySaihuMcp(f.path, f.root)).toBe(false);
  expect(readFileSync(f.path, "utf8")).toBe(snapshot);
  writeFileSync(f.path, original);
  expect(retireLegacySaihuMcp(f.path, f.root)).toBe(false);
  expect(readFileSync(f.path, "utf8")).toBe(original);
  const second = join(f.root, "another-mcp.yaml");
  writeFileSync(second, original);
  expect(retireLegacySaihuMcp(second, f.root)).toBe(true);
  expect(parse(readFileSync(second, "utf8")).mcpServers["lxe-saihu"].enabled).toBe(false);
});

test("already disabled configurations retain their exact bytes", () => {
  const source = original.replace("enabled: true", "enabled: false");
  const f = fixture(source);
  expect(retireLegacySaihuMcp(f.path, f.root)).toBe(true);
  expect(readFileSync(f.path, "utf8")).toBe(source);
});

test("supports the legacy servers root and does not rewrite shared YAML anchors", () => {
  const source = `servers:
  lxe-saihu: &shared
    enabled: true
    type: streamable-http
    url: http://example.test/mcp
  other: *shared
`;
  const f = fixture(source);
  retireLegacySaihuMcp(f.path, f.root);
  const saved = parse(readFileSync(f.path, "utf8"));
  expect(saved.servers["lxe-saihu"].enabled).toBe(false);
  expect(saved.servers.other).toEqual(parse(source).servers.other);
});

test("detaches an aliased legacy entry without disabling its source", () => {
  const source = `mcpServers:
  other: &shared {enabled: true, command: fixture-server}
  lxe-saihu: *shared
`;
  const f = fixture(source);
  retireLegacySaihuMcp(f.path, f.root);
  const saved = parse(readFileSync(f.path, "utf8")).mcpServers;
  expect(saved["lxe-saihu"].enabled).toBe(false);
  expect(saved.other.enabled).toBe(true);
});

test("missing and unrelated configurations need no migration files", () => {
  const f = fixture();
  expect(retireLegacySaihuMcp(f.path, f.root)).toBe(false);
  writeFileSync(f.path, "mcpServers: {other: {enabled: true, command: fixture-server}}\n");
  const source = readFileSync(f.path, "utf8");
  expect(retireLegacySaihuMcp(f.path, f.root)).toBe(false);
  expect(readFileSync(f.path, "utf8")).toBe(source);
  expect(existsSync(f.migrations)).toBe(false);
});

test("parse and backup failures remain actual errors and never start a partial migration", () => {
  const f = fixture("mcpServers: [broken");
  expect(() => retireLegacySaihuMcp(f.path, f.root)).toThrow();
  expect(existsSync(f.migrations)).toBe(false);
  writeFileSync(f.path, original);
  writeFileSync(f.migrations, "blocks the migration directory");
  expect(() => retireLegacySaihuMcp(f.path, f.root)).toThrow();
  expect(readFileSync(f.path, "utf8")).toBe(original);
  rmSync(f.migrations);
  expect(retireLegacySaihuMcp(f.path, f.root)).toBe(true);
  const marker = join(f.migrations, readdirSync(f.migrations).find(name => name.endsWith(".json"))!);
  writeFileSync(marker, "{}");
  expect(() => retireLegacySaihuMcp(f.path, f.root)).toThrow("Invalid MCP retirement marker");
});
