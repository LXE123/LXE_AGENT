import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMcpConfig, setMcpServerEnabled } from "../../src/tooling/mcp";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-json-"));
  roots.push(root);
  return { root, path: join(root, "mcp_servers.local.json") };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("JSON loading ignores a neighboring YAML file and never rewrites it", () => {
  const { root, path } = fixture();
  const legacy = join(root, "mcp_servers.local.yaml");
  const old = "mcpServers:\n  old:\n    enabled: true\n    command: must-not-launch\n";
  writeFileSync(legacy, old);
  expect(loadMcpConfig(path, {}).servers).toEqual([]);
  writeFileSync(path, '{"servers":{}}');
  expect(loadMcpConfig(path, {}).servers).toEqual([]);
  expect(readFileSync(legacy, "utf8")).toBe(old);
});

test("toggle preserves JSON fields and unresolved credentials without storing runtime state", () => {
  const { path } = fixture();
  const config = { servers: {
    local: { enabled: false, command: "node", args: ["server.js"], env: { SECRET: "${SECRET}" } },
    remote: { enabled: true, transport: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
  }, notes: "keep this field" };
  writeFileSync(path, JSON.stringify(config));
  const loaded = loadMcpConfig(path, { SECRET: "resolved-only-in-memory" });
  expect(loaded.servers[0]?.env.SECRET).toBe("resolved-only-in-memory");
  setMcpServerEnabled(path, "local", true);
  config.servers.local.enabled = true;
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(config);
  expect(readFileSync(path, "utf8")).not.toContain("resolved-only-in-memory");
  expect(() => setMcpServerEnabled(path, "unknown", true)).toThrow("MCP server not found");
});

test("malformed JSON and invalid configuration shapes fail explicitly", () => {
  const { path } = fixture();
  for (const text of ["servers: {}", "{", "[]", "null", '{"servers":null}', '{"servers":[]}', '{"servers":{"bad":null}}', '{"servers":{},"mcpServers":{}}']) {
    writeFileSync(path, text);
    expect(() => loadMcpConfig(path, {})).toThrow();
  }
  for (const server of [
    { enabled: true }, { command: "" }, { transport: "streamable-http" },
    { command: "node", enabled: "true" }, { command: "node", args: "server.js" },
    { command: "node", env: [] }, { command: "node", headers: { Token: 123 } },
  ]) {
    writeFileSync(path, JSON.stringify({ servers: { invalid: server } }));
    expect(() => loadMcpConfig(path, {})).toThrow();
  }
});
