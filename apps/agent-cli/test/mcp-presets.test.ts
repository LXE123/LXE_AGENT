import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerPreset } from "@lxe/desktop-protocol";
import { loadMcpConfig, setMcpServerEnabled } from "@lxe/runtime";
import { syncMcpServerPresets } from "../src/mcp-presets";
import { withMcpConfigLock } from "../src/mcp-config-lock";

const roots: string[] = [];
const preset: McpServerPreset = { name: "team-skills", enabled: true, transport: "streamable-http", url: "https://example.com/mcp" };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(contents?: string) {
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-presets-")); roots.push(root);
  const path = join(root, "mcp_servers.local.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return { root, path, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

test("creates missing configuration, restores deleted presets, and leaves an unchanged file untouched", async () => {
  const { path, read } = fixture();
  expect(await syncMcpServerPresets(path, [preset])).toEqual({ added: ["team-skills"], updated: [] });
  expect(loadMcpConfig(path, {}).servers[0]).toMatchObject({ name: "team-skills", enabled: true, url: preset.url });
  const document = read();
  const formatted = JSON.stringify(document);
  writeFileSync(path, formatted);
  const before = statSync(path);
  expect(await syncMcpServerPresets(path, [preset])).toEqual({ added: [], updated: [] });
  expect(readFileSync(path, "utf8")).toBe(formatted);
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  writeFileSync(path, '{"servers":{}}');
  await syncMcpServerPresets(path, [preset]);
  expect(read()).toEqual(document);
});

test.each(["servers", "mcpServers"])("upgrades %s without losing unrelated data or legacy files", async key => {
  const other = { type: "stdio", command: "custom", args: ["${ARG}"], enabled: false };
  const { root, path, read } = fixture(JSON.stringify({ metadata: { revision: 2 }, [key]: { other } }));
  const legacy = join(root, "mcp_servers.local.yaml");
  writeFileSync(legacy, "legacy bytes\n");
  await syncMcpServerPresets(path, [preset]);
  expect(read()).toEqual({ metadata: { revision: 2 }, [key]: { other, "team-skills": {
    enabled: true, transport: "streamable-http", url: preset.url,
  } } });
  expect(readFileSync(legacy, "utf8")).toBe("legacy bytes\n");
});

test.each([true, false, undefined])("repairs connection fields and preserves enabled=%s and user options", async enabled => {
  const current = { ...(enabled === undefined ? {} : { enabled }), transport: "stdio", command: "old",
    url: "invalid-url", headers: { Authorization: "${TOKEN}" }, oauth: { clientId: "client" }, startup_timeout_s: 45,
    disabled_tools: ["delete"], exposure: "hidden" };
  const { path, read } = fixture(JSON.stringify({ servers: { "team-skills": current } }));
  expect(await syncMcpServerPresets(path, [preset])).toEqual({ added: [], updated: ["team-skills"] });
  expect(read().servers["team-skills"]).toEqual({ ...current, transport: preset.transport, url: preset.url });
  expect(loadMcpConfig(path, {}).servers[0]?.enabled).toBe(enabled === true);
});

test.each(["{", "[]", '{"servers":[]}', '{"servers":{},"mcpServers":{}}',
  '{"servers":{"team-skills":null}}', '{"servers":{"team-skills":{"enabled":"false"}}}',
  '{"servers":{"team_skills":{"command":"node"}}}'])("keeps invalid or conflicting configuration intact: %s", async contents => {
  const { path } = fixture(contents);
  await expect(syncMcpServerPresets(path, [preset])).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe(contents);
});

test("validates a whole batch before writing, and supports more than one preset", async () => {
  const { path, read } = fixture();
  await expect(syncMcpServerPresets(path, [preset, { ...preset, name: "team_skills" }])).rejects.toThrow("Duplicate MCP preset namespace");
  expect(existsSync(path)).toBe(false);
  const second: McpServerPreset = { name: "local", transport: "stdio", command: "node", args: ["server.js"], enabled: false };
  expect(await syncMcpServerPresets(path, [preset, second])).toEqual({ added: ["team-skills", "local"], updated: [] });
  expect(read().servers.local).toEqual({ transport: "stdio", command: "node", args: ["server.js"], enabled: false });
  const contents = '{"servers":{"local":null}}';
  writeFileSync(path, contents);
  await expect(syncMcpServerPresets(path, [preset, second])).rejects.toThrow("local must be an object");
  expect(readFileSync(path, "utf8")).toBe(contents);
});

test("rereads the file after taking the same lock used by configuration edits", async () => {
  const { path, read } = fixture();
  await syncMcpServerPresets(path, [preset]);
  let pending!: ReturnType<typeof syncMcpServerPresets>;
  await withMcpConfigLock(path, () => {
    pending = syncMcpServerPresets(path, [preset]);
    setMcpServerEnabled(path, "team-skills", false);
  });
  await pending;
  expect(read().servers["team-skills"].enabled).toBe(false);
});
