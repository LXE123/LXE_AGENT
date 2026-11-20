import { describe, expect, test } from "bun:test";
import {
  parseDeviceContext,
  parseServerDevicePermissionV2,
  parseStoredDevicePermission,
  permissionSnapshotsEqual,
} from "../src/main/cloud-permissions";

const v2Permission = (patch: Record<string, unknown> = {}) => ({
  response_schema: "lxe.device-permission.v2",
  assignment_version: 3,
  profile: {
    id: "shopee",
    revision: 1,
    labels: { "zh-CN": "Shopee", "en-US": "Shopee" },
  },
  grants: {
    skill_types: ["shopee_operations", "default"],
    desktop_features: [],
  },
  ...patch,
});

describe("device permission snapshots", () => {
  test("renames validated persisted grants only and preserves verification metadata", () => {
    for (const permission_schema of [1, 2]) {
      const old = { device_id: "device-1", permission_schema, permission_profile: "replenishment",
        permission_version: 3, profile_revision: permission_schema === 1 ? 1 : 9,
        profile_labels: { "zh-CN": "备货", "en-US": "Replenishment" },
        allowed_skill_types: ["amazon_replenish", "default"], desktop_features: [], verified_at: 123 };
      const next = parseStoredDevicePermission(old)!;
      expect(next).toEqual({ ...old, allowed_skill_types: ["replenishment", "default"] });
      expect(parseStoredDevicePermission(next)).toEqual(next);
      expect(parseStoredDevicePermission({ ...old, allowed_skill_types: ["amazon_replenish", "amazon_replenish"] })).toBeNull();
      expect(parseStoredDevicePermission({ ...old, allowed_skill_types: ["amazon_replenish", "*"] })).toBeNull();
      expect(parseStoredDevicePermission({ ...old, allowed_skill_types: ["amazon_replenish", "bad-name!"] })).toBeNull();
    }
    expect(parseServerDevicePermissionV2(v2Permission({ grants: { skill_types: ["amazon_replenish"], desktop_features: [] } }), "device-1", 456).allowed_skill_types)
      .toEqual(["amazon_replenish"]); // No online alias can authorize the renamed bundled skills.
    expect(parseStoredDevicePermission({ device_id: "device-1", permission_schema: 2, permission_profile: null,
      permission_version: 3, profile_revision: 0, profile_labels: {}, allowed_skill_types: [], desktop_features: [], verified_at: 123 }))
      .toMatchObject({ allowed_skill_types: [], permission_profile: null });
  });

  test("accepts an unknown server-owned v2 profile without expanding it locally", () => {
    expect(parseServerDevicePermissionV2(v2Permission(), "device-1", 123)).toEqual({
      device_id: "device-1",
      permission_schema: 2,
      permission_profile: "shopee",
      permission_version: 3,
      profile_revision: 1,
      profile_labels: { "zh-CN": "Shopee", "en-US": "Shopee" },
      allowed_skill_types: ["shopee_operations", "default"],
      desktop_features: [],
      verified_at: 123,
    });
  });

  test("accepts a consistent unassigned v2 snapshot", () => {
    expect(parseServerDevicePermissionV2(v2Permission({
      assignment_version: 0,
      profile: null,
      grants: { skill_types: [], desktop_features: [] },
    }), "device-1", 123)).toMatchObject({
      permission_profile: null,
      permission_version: 0,
      allowed_skill_types: [],
    });
  });

  test("rejects malformed v2 grants, mixed wildcards, and unknown schemas", () => {
    const cases = [
      v2Permission({ response_schema: "lxe.device-permission.v3" }),
      v2Permission({ profile: { id: "Shopee", revision: 1, labels: { "zh-CN": "Shopee", "en-US": "Shopee" } } }),
      v2Permission({ grants: { skill_types: ["default", "default"], desktop_features: [] } }),
      v2Permission({ grants: { skill_types: ["*", "default"], desktop_features: [] } }),
      v2Permission({ grants: { skill_types: [], desktop_features: ["*", "erp_dashboard"] } }),
      v2Permission({ assignment_version: 0 }),
      v2Permission({ profile: null }),
    ];
    for (const value of cases) {
      expect(() => parseServerDevicePermissionV2(value, "device-1", 123)).toThrow();
    }
  });

  test("accepts a wildcard when it is the only grant", () => {
    expect(parseServerDevicePermissionV2(v2Permission({
      grants: { skill_types: ["*"], desktop_features: ["*"] },
    }), "device-1", 123)).toMatchObject({
      allowed_skill_types: ["*"],
      desktop_features: ["*"],
    });
  });

  test("round-trips v2 encrypted snapshots and rejects malformed stored data", () => {
    const snapshot = parseServerDevicePermissionV2(v2Permission(), "device-1", 123);
    expect(parseStoredDevicePermission(snapshot)).toEqual(snapshot);
    expect(parseStoredDevicePermission({ ...snapshot, allowed_skill_types: ["bad-type!"] }))
      .toBeNull();
    expect(permissionSnapshotsEqual(snapshot, { ...snapshot, verified_at: 999 })).toBe(true);
  });
});

test("complete context cache preserves business grants, rejects partial metadata and keeps legacy grants unknown", () => {
  const context = { response_schema: "lxe.device-context.v1", device: { id: "device-1", kind: "managed_device", display_name: "Device", wireguard_ip: "10.88.0.8" },
    permission: { ...v2Permission(), grants: { skill_types: ["replenishment"], desktop_features: [], server_capabilities: ["mabang_read"], erp_actions: [] } } };
  const snapshot = parseDeviceContext(context, undefined, undefined, 123);
  snapshot.observed_device!.server_url = "http://10.88.0.1:8000";
  expect(parseStoredDevicePermission(snapshot)).toEqual(snapshot);
  expect(parseStoredDevicePermission({ ...snapshot, erp_actions: undefined })).toBeNull();
  expect(parseStoredDevicePermission({ ...snapshot, observed_device: { ...snapshot.observed_device, id: "other" } })).toBeNull();
  expect(parseStoredDevicePermission(parseServerDevicePermissionV2(v2Permission(), "device-1", 123))?.server_capabilities).toBeUndefined();
  expect(() => parseDeviceContext({ ...context, device: { ...context.device, wireguard_ip: "garbage" } }, undefined, undefined, 123)).toThrow("identity");
});
