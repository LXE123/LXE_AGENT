import { describe, expect, test } from "bun:test";
import {
  parseServerDevicePermission,
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
  test("keeps the frozen v1 profile projection for legacy servers", () => {
    expect(parseServerDevicePermission({
      permission_profile: "fba",
      permission_version: 3,
      allowed_skill_types: ["default", "amazon_fba", "ziniao_browser"],
    }, "device-1", 123)).toEqual({
      device_id: "device-1",
      permission_schema: 1,
      permission_profile: "fba",
      permission_version: 3,
      profile_revision: 1,
      profile_labels: { "zh-CN": "FBA", "en-US": "FBA" },
      allowed_skill_types: ["amazon_fba", "ziniao_browser", "default"],
      desktop_features: ["erp_dashboard"],
      verified_at: 123,
    });
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
