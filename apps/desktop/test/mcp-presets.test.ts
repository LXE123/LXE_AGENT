import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDesktopMcpPresets } from "../src/main/gateway/mcp-presets";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("the shipped resource supplies enabled team-skills through the MCP preset contract", () => {
  expect(loadDesktopMcpPresets("config/mcp_servers.default.json")).toEqual([{
    name: "team-skills", enabled: true, transport: "streamable-http",
    connector_description: "Search, download, and publish agent skills shared by your team. When the user asks to install a skill, place the entire downloaded skill directory under `environment_context.user_skills_root`, including `SKILL.md` and all supporting files.",
    url: "https://qcnd7w5806gy.feishu.link/mcp/app_17gftabyhpd",
  }]);
});

test("invalid product resources fail instead of silently omitting presets", () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-desktop-presets-")); roots.push(root);
  const path = join(root, "defaults.json");
  for (const content of ["{", "null", '{"servers":[]}', '{"servers":{"bad":null}}',
    '{"servers":{"bad":{"name":"different","enabled":true,"transport":"stdio","command":"node"}}}']) {
    writeFileSync(path, content);
    expect(() => loadDesktopMcpPresets(path)).toThrow();
  }
});
