import { describe, expect, test } from "bun:test";
import type { DesktopInputAssetSlot, DesktopVietnamSkuMapMutation } from "@lxe/desktop-protocol";
import { createVietnamSkuMapActions } from "../src/main/vietnam-sku-map-actions";

const revision = "a".repeat(32);
const newRevision = "b".repeat(32);
const slot = (patch: Partial<DesktopInputAssetSlot> = {}): DesktopInputAssetSlot => ({
  slot: "vietnam_sku_parameter_map",
  management: "desktop",
  manifest_revision: revision,
  display_name: "越南 SKU 参数表",
  used_by: ["越南备货清单生成"],
  holds: "成本和价格",
  directory: "/state/inputs/vietnam/sku_parameter_map",
  current: null,
  previous: null,
  ...patch,
});
const installed: DesktopVietnamSkuMapMutation = { status: "installed", manifest_revision: newRevision };

describe("Vietnam SKU map Main actions", () => {
  test("canceling native selection does not start Python", async () => {
    let installs = 0;
    const actions = createVietnamSkuMapActions({
      list: async () => [slot()],
      choose: async () => ({ canceled: true, filePaths: [] }),
      install: async () => { installs += 1; return installed; },
      rollback: async () => installed,
    });
    expect(await actions.upload()).toBeNull();
    expect(installs).toBe(0);
  });

  test("passes only the native selected path and pre-dialog revision", async () => {
    let current = revision;
    const calls: Array<[string, string | null]> = [];
    const actions = createVietnamSkuMapActions({
      list: async () => [slot({ manifest_revision: current })],
      choose: async () => {
        current = newRevision;
        return { canceled: false, filePaths: ["/native/selected.xlsx"] };
      },
      install: async (source, expected) => { calls.push([source, expected]); return installed; },
      rollback: async () => installed,
    });
    expect(await actions.upload()).toEqual(installed);
    expect(calls).toEqual([["/native/selected.xlsx", revision]]);
  });

  test("blocks writes when manifest is malformed", async () => {
    let opened = false;
    const actions = createVietnamSkuMapActions({
      list: async () => [slot({ manifest_revision: null, manifest_error: "manifest.json 无效" })],
      choose: async () => { opened = true; return { canceled: true, filePaths: [] }; },
      install: async () => installed,
      rollback: async () => installed,
    });
    await expect(actions.upload()).rejects.toThrow("manifest.json 无效");
    expect(opened).toBe(false);
  });

  test("propagates the observed compare-and-swap conflict", async () => {
    const actions = createVietnamSkuMapActions({
      list: async () => [slot()],
      choose: async () => ({ canceled: false, filePaths: ["/native/selected.xlsx"] }),
      install: async () => { throw new Error("映射表已变化，请刷新后重试"); },
      rollback: async () => installed,
    });
    await expect(actions.upload()).rejects.toThrow("映射表已变化");
  });

  test("rollback forwards exactly one revision", async () => {
    const calls: string[] = [];
    const actions = createVietnamSkuMapActions({
      list: async () => [slot()],
      choose: async () => ({ canceled: true, filePaths: [] }),
      install: async () => installed,
      rollback: async (expected) => { calls.push(expected); return {status: "rolled_back", manifest_revision: newRevision}; },
    });
    expect(await actions.rollback(revision)).toEqual({status: "rolled_back", manifest_revision: newRevision});
    expect(calls).toEqual([revision]);
  });
});
