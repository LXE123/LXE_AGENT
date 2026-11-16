import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDesktopMcpPresets } from "../src/main/mcp-presets";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("the shipped resource supplies enabled team-skills through the MCP preset contract", () => {
  expect(loadDesktopMcpPresets("config/mcp_servers.default.json")).toEqual([{
    name: "team-skills", enabled: true, transport: "streamable-http",
    connector_description: "`team-skills` 用于搜索、下载和发布团队共享的 Agent 技能。用户要求安装技能时，将下载的完整技能目录放到 `environment_context` 的 `user_skills_root` 下，保留其中的 `SKILL.md` 和配套文件。",
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
