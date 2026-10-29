import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapDesktopState, migrateLegacyArtifacts } from "../src/main/migration";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lxe-bootstrap-")); roots.push(root);
  const source = join(root, "default.yaml"), data = join(root, "data");
  const defaults = readFileSync("config/mcp_servers.default.yaml", "utf8");
  writeFileSync(source, defaults);
  return { source, data, defaults, target: join(data, "config/mcp_servers.local.yaml") };
}
test("initializes the native disabled default", () => {
  const f = fixture(); bootstrapDesktopState(f.source, f.data);
  expect(readFileSync(f.target, "utf8")).toBe(f.defaults);
  expect(f.defaults).toContain("X-LXE-Client: cli");
  expect(f.defaults).toContain("enabled: false");
});

function artifactFixture() {
  const { data } = fixture();
  return { data, source: join(data, "artifacts"), target: join(data, "workspace", ".lxeagent", "artifacts"),
    staging: join(data, "workspace", ".lxeagent", ".default-workspace-artifacts-v1.staging"),
    marker: join(data, "migrations", "default-workspace-artifacts-v1.json") };
}

test("copies old artifacts to only the default workspace, retaining original bytes and empty directories", async () => {
  const f = artifactFixture();
  mkdirSync(join(f.source, "fba", "空目录"), { recursive: true });
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  writeFileSync(join(f.source, "fba", "发货单.xlsx"), bytes);
  writeFileSync(join(f.source, ".hidden"), "hidden");
  const external = join(f.data, "other-workspace");
  mkdirSync(external);
  await migrateLegacyArtifacts(f.data);
  expect(readFileSync(join(f.target, "fba", "发货单.xlsx"))).toEqual(bytes);
  expect(readFileSync(join(f.source, "fba", "发货单.xlsx"))).toEqual(bytes);
  expect(readFileSync(join(f.target, ".hidden"), "utf8")).toBe("hidden");
  expect(lstatSync(join(f.target, "fba", "空目录")).isDirectory()).toBe(true);
  expect(existsSync(join(external, ".lxeagent"))).toBe(false);
  expect(existsSync(f.staging)).toBe(false);
  expect(JSON.parse(readFileSync(f.marker, "utf8"))).toMatchObject({ version: 1, source: f.source, target: f.target });
});

test("keeps newer destination entries, fills missing entries, and never imports again after completion", async () => {
  const f = artifactFixture();
  mkdirSync(join(f.source, "module", "conflict"), { recursive: true });
  mkdirSync(join(f.target, "module"), { recursive: true });
  writeFileSync(join(f.source, "module", "existing.txt"), "old");
  writeFileSync(join(f.source, "module", "missing.txt"), "copy me");
  writeFileSync(join(f.source, "module", "conflict", "nested.txt"), "old nested");
  writeFileSync(join(f.target, "module", "existing.txt"), "new");
  writeFileSync(join(f.target, "module", "conflict"), "keep this file");
  await migrateLegacyArtifacts(f.data);
  expect(readFileSync(join(f.target, "module", "existing.txt"), "utf8")).toBe("new");
  expect(readFileSync(join(f.target, "module", "missing.txt"), "utf8")).toBe("copy me");
  expect(readFileSync(join(f.target, "module", "conflict"), "utf8")).toBe("keep this file");
  rmSync(f.target, { recursive: true });
  await migrateLegacyArtifacts(f.data, async () => { throw new Error("must not copy twice"); });
  expect(existsSync(f.target)).toBe(false);
  expect(readFileSync(join(f.source, "module", "existing.txt"), "utf8")).toBe("old");
});

test("a partial copy preserves the actual failure, publishes nothing, and can retry from the source", async () => {
  const f = artifactFixture();
  mkdirSync(f.source, { recursive: true });
  writeFileSync(join(f.source, "report.csv"), "complete report");
  const failure = Object.assign(new Error("ENOSPC: no space left on device, copyfile report.csv"), { code: "ENOSPC" });
  let observed: unknown;
  try {
    await migrateLegacyArtifacts(f.data, async (_source, staging) => {
      mkdirSync(String(staging), { recursive: true });
      writeFileSync(join(String(staging), "report.csv"), "partial");
      throw failure;
    });
  } catch (error) { observed = error; }
  expect(observed).toBeInstanceOf(Error);
  expect((observed as Error).cause).toBe(failure);
  expect((observed as Error).message).toContain(failure.message);
  expect(existsSync(f.marker)).toBe(false);
  expect(existsSync(f.target)).toBe(false);
  expect(readFileSync(join(f.source, "report.csv"), "utf8")).toBe("complete report");
  await migrateLegacyArtifacts(f.data);
  expect(readFileSync(join(f.target, "report.csv"), "utf8")).toBe("complete report");
  expect(existsSync(f.marker)).toBe(true);
  expect(existsSync(f.staging)).toBe(false);
});

test("fresh installations record completion without creating a legacy artifact root", async () => {
  const f = artifactFixture();
  await migrateLegacyArtifacts(f.data);
  expect(existsSync(f.source)).toBe(false);
  expect(existsSync(f.target)).toBe(false);
  expect(existsSync(f.marker)).toBe(true);
});

test("does not write through destination directory links", async () => {
  const f = artifactFixture();
  const outside = join(f.data, "outside");
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(f.source, "linked"), { recursive: true });
  mkdirSync(f.target, { recursive: true });
  writeFileSync(join(f.source, "linked", "old.txt"), "old");
  symlinkSync(outside, join(f.target, "linked"), process.platform === "win32" ? "junction" : "dir");
  await migrateLegacyArtifacts(f.data);
  expect(lstatSync(join(f.target, "linked")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(outside, "old.txt"))).toBe(false);
  expect(existsSync(join(f.source, "linked", "old.txt"))).toBe(true);
});

test("rejects a redirected default workspace root without marking migration complete", async () => {
  const f = artifactFixture();
  const outside = join(f.data, "outside");
  mkdirSync(outside, { recursive: true });
  mkdirSync(f.source);
  symlinkSync(outside, join(f.data, "workspace"), process.platform === "win32" ? "junction" : "dir");
  await expect(migrateLegacyArtifacts(f.data)).rejects.toThrow("Expected a directory without a symbolic link");
  expect(existsSync(f.marker)).toBe(false);
  expect(existsSync(join(outside, ".lxeagent"))).toBe(false);
});
test("does not convert old company credentials or overwrite local settings", () => {
  const f = fixture(); mkdirSync(join(f.data, "config"), { recursive: true });
  const old = "mcpServers:\n  lxe-saihu:\n    enabled: false\n    url: http://10.88.0.1:8000/mcp/\n    bearer_token_env_var: LXE_SAIHU_MCP_API_KEY\n    startup_timeout_s: 17\n    disabled_tools: [write]\n";
  writeFileSync(f.target, old);
  const state = join(f.data, "config/unrelated.json");
  writeFileSync(state, '{"other":true}');
  bootstrapDesktopState(f.source, f.data); bootstrapDesktopState(f.source, f.data);
  expect(readFileSync(f.target, "utf8")).toBe(old);
  expect(readFileSync(state, "utf8")).toBe('{"other":true}');
});
