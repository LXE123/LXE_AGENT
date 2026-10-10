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
  slot: "desktop_fixture",
  display_name: "Desktop fixture",
  management: "desktop",
  manifest_revision: "a".repeat(32),
  current_error: "当前版本 SHA-256 不一致",
  used_by: ["Fixture workflow"],
  holds: "Fixture data",
  directory: "/state/inputs/test/desktop_fixture",
  current: null,
  previous: {
    file_name: "previous.xlsx", path: "/state/inputs/test/desktop_fixture/versions/old.xlsx",
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
