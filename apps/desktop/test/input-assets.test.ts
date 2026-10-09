import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopInputAssetsService, type AssetCommandExecution } from "../src/main/input-assets";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const assetService = (
  execute: NonNullable<ConstructorParameters<typeof DesktopInputAssetsService>[0]["execute"]>,
) => {
  const root = mkdtempSync(join(tmpdir(), "lxe-input-assets-test-"));
  roots.push(root);
  return new DesktopInputAssetsService({
    dataRoot: root,
    pythonPath: process.execPath,
    managedPath: root,
    platform: process.platform,
    execute,
  });
};

const terminal = (data: Record<string, unknown>) => JSON.stringify({
  type: "result", ok: true, data, files: [],
}) + "\n";
const executed = (stdout: string, error: Error | null = null, stderr = ""): AssetCommandExecution => ({ stdout, stderr, error });

const managedSlot = {
  slot: "vietnam_sku_parameter_map",
  display_name: "越南 SKU 参数表",
  management: "desktop",
  manifest_revision: "a".repeat(32),
  current_error: "当前版本 SHA-256 不一致",
  used_by: ["越南备货清单生成"],
  holds: "按 SKU 填写价格",
  directory: "/state/inputs/vietnam/sku_parameter_map",
  current: null,
  previous: {
    file_name: "previous.xlsx", path: "/state/inputs/vietnam/sku_parameter_map/versions/old.xlsx",
    size_bytes: 128, updated_at: "2026-10-03",
  },
};

describe("DesktopInputAssetsService", () => {
  test("keeps managed revision, validated previous, and factual current error in list", async () => {
    const service = assetService(async () => executed(terminal({ success: true, slots: [managedSlot] })));
    expect(await service.list()).toEqual([managedSlot]);
  });

  test("surfaces the CLI result error from stdout even on nonzero child exit", async () => {
    const service = assetService(async () => executed(JSON.stringify({
      type: "result", ok: false,
      data: { success: false, error: { code: "invalid_map", message: "SKU A 缺少成本" } },
      error: { code: "business_failed", message: "SKU A 缺少成本" },
    }) + "\n", new Error("Command failed")));
    await expect(service.list()).rejects.toThrow("SKU A 缺少成本");
    await expect(service.list()).rejects.not.toThrow("Command failed");
  });

  test("uses observed stderr if the child emitted no structured terminal", async () => {
    const service = assetService(async () => executed("not-json\n", new Error("Command failed"), "Python module missing: lxeskill"));
    await expect(service.list()).rejects.toThrow("Python module missing: lxeskill");
  });

  test("uses fixed internal commands and managed environment", async () => {
    const calls: Array<{ args: string[]; environment: NodeJS.ProcessEnv }> = [];
    const service = assetService(async (args, options) => {
      calls.push({ args, environment: options.env ?? {} });
      return executed(terminal({success: true, status: "installed", manifest_revision: "b".repeat(32)}));
    });
    expect(await service.installVietnamSkuMap("/selected/map.xlsx", null)).toEqual({
      status: "installed", manifest_revision: "b".repeat(32),
    });
    expect(calls[0]!.args).toEqual([
      "-I", "-B", "-m", "lxeskill", "assets", "vietnam", "sku", "install",
      "--source-path", "/selected/map.xlsx", "--expected-revision", "",
    ]);
    expect(calls[0]!.environment.LXE_DATA_ROOT).toBeTruthy();
    expect(calls[0]!.environment.LXE_SQLITE_DB_PATH).toContain("lxeskill.sqlite3");
    expect(calls[0]!.environment.LXE_WORKSPACE_ROOT).toContain("workspace");
    expect(calls[0]!.environment.LXE_MANAGED_PATH).toBeTruthy();
  });

  test("redacts known secrets and marks truncated diagnostics", async () => {
    const previous = process.env.LXE_YACANG_PASSWORD;
    process.env.LXE_YACANG_PASSWORD = "secret-for-test";
    try {
      const service = assetService(async () => executed(JSON.stringify({
        type: "result", ok: false,
        error: { message: `${"X".repeat(5000)} reason: secret-for-test` },
      }) + "\n", new Error("Command failed")));
      await expect(service.list()).rejects.toThrow("[truncated]");
      try { await service.list(); } catch (cause) {
        expect(String(cause)).not.toContain("secret-for-test");
      }
    } finally {
      if (previous === undefined) delete process.env.LXE_YACANG_PASSWORD;
      else process.env.LXE_YACANG_PASSWORD = previous;
    }
  });
});
