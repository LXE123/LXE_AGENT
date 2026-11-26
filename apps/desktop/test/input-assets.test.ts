import { afterEach, describe, expect, test } from "bun:test";
import { DesktopInputAssetsService } from "../src/main/lxeskill/input-assets";
import { fixtureClient, removeFixtures, resultLine } from "./support/lxeskill-fixture";

afterEach(removeFixtures);

/** The fixture CLI prints `stdout`, then `stderr`, and exits with `code`. */
const assetService = (stdout: string, code = 0, stderr = "", environment?: () => Record<string, string | undefined>) =>
  new DesktopInputAssetsService(fixtureClient(`
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exitCode = ${code};
`, environment ? { environment } : {}).client);

const terminal = (data: Record<string, unknown>) => resultLine({ command: "assets list", data }) + "\n";

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
    const service = assetService(terminal({ success: true, slots: [managedSlot] }));
    expect(await service.list()).toEqual([managedSlot]);
  });

  test("surfaces the CLI result error from stdout even on nonzero child exit", async () => {
    const service = assetService(resultLine({
      command: "assets list", ok: false,
      data: { success: false, error: { code: "invalid_map", message: "SKU A 缺少成本" } },
      error: { code: "business_failed", message: "SKU A 缺少成本" },
    }) + "\n", 2);
    await expect(service.list()).rejects.toThrow("SKU A 缺少成本");
    await expect(service.list()).rejects.not.toThrow("exited with code");
  });

  test("uses observed stderr if the child emitted no structured terminal", async () => {
    const service = assetService("not-json\n", 1, "Python module missing: lxeskill");
    await expect(service.list()).rejects.toThrow("Python module missing: lxeskill");
  });

  test("redacts known secrets and marks truncated diagnostics", async () => {
    const service = assetService(resultLine({
      command: "assets list", ok: false,
      error: { message: `${"X".repeat(5000)} reason: secret-for-test` },
    }) + "\n", 1, "", () => ({ ...process.env, LXE_YACANG_PASSWORD: "secret-for-test" }));
    await expect(service.list()).rejects.toThrow("[truncated]");
    await expect(service.list()).rejects.not.toThrow("secret-for-test");
  });
});
