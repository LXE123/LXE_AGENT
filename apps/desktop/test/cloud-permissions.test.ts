import { describe, expect, test } from "bun:test";
import {
  parseServerDevicePermission,
  parseStoredDevicePermission,
} from "../src/main/cloud-permissions";

describe("device permission snapshots", () => {
  test("accepts only the server-defined profile contents", () => {
    expect(parseServerDevicePermission({
      permission_profile: "fba",
      permission_version: 3,
      allowed_skill_types: ["default", "amazon_fba", "ziniao_browser"],
    }, "device-1", 123)).toEqual({
      device_id: "device-1",
      permission_profile: "fba",
      permission_version: 3,
      allowed_skill_types: ["amazon_fba", "ziniao_browser", "default"],
      verified_at: 123,
    });
    expect(parseServerDevicePermission({
      permission_profile: null,
      permission_version: 0,
      allowed_skill_types: [],
    }, "device-1", 123).allowed_skill_types).toEqual([]);
  });

  test("rejects unknown, expanded, duplicate, and inconsistent permissions", () => {
    const cases = [
      { permission_profile: "admin", permission_version: 1, allowed_skill_types: ["*"] },
      { permission_profile: "fba", permission_version: 1, allowed_skill_types: ["*"] },
      { permission_profile: "fba", permission_version: 1, allowed_skill_types: ["amazon_fba", "ziniao_browser", "default", "default"] },
      { permission_profile: null, permission_version: 1, allowed_skill_types: [] },
    ];
    for (const value of cases) {
      expect(() => parseServerDevicePermission(value, "device-1", 123)).toThrow();
    }
  });

  test("fails closed when an encrypted stored snapshot is malformed", () => {
    expect(parseStoredDevicePermission({
      device_id: "device-1",
      permission_profile: "fba",
      permission_version: 1,
      allowed_skill_types: ["*"],
      verified_at: 123,
    })).toBeNull();
    expect(parseStoredDevicePermission({
      device_id: "device-1",
      permission_profile: "full_access",
      permission_version: 1,
      allowed_skill_types: ["*"],
      verified_at: 123,
    })).toMatchObject({ permission_profile: "full_access" });
  });
});
