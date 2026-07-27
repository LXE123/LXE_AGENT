import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapDesktopState } from "../src/main/migration";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (localSource: string) => {
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-default-migration-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const defaultPath = join(root, "mcp_servers.default.yaml");
  mkdirSync(join(dataRoot, "config"), { recursive: true });
  writeFileSync(defaultPath, "mcpServers: {}\n", "utf8");
  const localPath = join(dataRoot, "config", "mcp_servers.local.yaml");
  writeFileSync(localPath, localSource, "utf8");
  return { dataRoot, defaultPath, localPath };
};

describe("desktop MCP default migration", () => {
  test("updates only the old localhost and Data Server bearer defaults", () => {
    const { dataRoot, defaultPath, localPath } = fixture([
      "mcpServers:",
      "  lxe-saihu:",
      "    enabled: true",
      "    type: streamable-http",
      "    url: http://127.0.0.1:8000/mcp/",
      "    bearer_token_env_var: LXE_DATA_SERVER_API_KEY",
      "    exposure: direct",
      "    enabled_tools: [get_shop_page_list]",
      "    disabled_tools: [dangerous_tool]",
      "    connector_id: custom-saihu",
      "",
    ].join("\n"));

    bootstrapDesktopState(defaultPath, dataRoot);

    const migrated = readFileSync(localPath, "utf8");
    expect(migrated).toContain("url: http://10.88.0.1:8000/mcp/");
    expect(migrated).toContain("bearer_token_env_var: LXE_SAIHU_MCP_API_KEY");
    expect(migrated).toContain("enabled: true");
    expect(migrated).toContain("exposure: direct");
    expect(migrated).toContain("enabled_tools: [ get_shop_page_list ]");
    expect(migrated).toContain("disabled_tools: [ dangerous_tool ]");
    expect(migrated).toContain("connector_id: custom-saihu");
  });

  test("converts the historical Authorization header and preserves other headers", () => {
    const { dataRoot, defaultPath, localPath } = fixture([
      "mcpServers:",
      "  lxe-saihu:",
      "    enabled: false",
      "    type: streamable-http",
      "    url: http://localhost:8000/mcp/",
      "    headers:",
      "      Authorization: 'Bearer ${LXE_DATA_SERVER_API_KEY}'",
      "      X-Environment: development",
      "",
    ].join("\n"));

    bootstrapDesktopState(defaultPath, dataRoot);

    const migrated = readFileSync(localPath, "utf8");
    expect(migrated).toContain("url: http://10.88.0.1:8000/mcp/");
    expect(migrated).toContain("bearer_token_env_var: LXE_SAIHU_MCP_API_KEY");
    expect(migrated).toContain("X-Environment: development");
    expect(migrated).not.toContain("Authorization:");
    expect(migrated).not.toContain("LXE_DATA_SERVER_API_KEY");
  });

  test("leaves custom endpoints or credentials byte-for-byte unchanged", () => {
    const customSources = [
      "mcpServers:\n  lxe-saihu:\n    url: https://custom.example/mcp\n    bearer_token_env_var: LXE_DATA_SERVER_API_KEY\n",
      "mcpServers:\n  lxe-saihu:\n    url: http://127.0.0.1:8000/mcp/\n    bearer_token_env_var: CUSTOM_TOKEN\n",
      "mcpServers:\n  lxe-saihu:\n    url: http://127.0.0.1:8000/mcp/\n    headers: {Authorization: Bearer custom-token}\n",
      "mcpServers: [invalid-shape]\n",
    ];
    for (const source of customSources) {
      const { dataRoot, defaultPath, localPath } = fixture(source);
      bootstrapDesktopState(defaultPath, dataRoot);
      expect(readFileSync(localPath, "utf8")).toBe(source);
    }
  });
});
