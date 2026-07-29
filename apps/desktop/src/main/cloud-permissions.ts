import type {
  DesktopCloudPermissionSnapshot,
  DesktopPermissionProfile,
} from "@lxe/desktop-protocol";

export const DEVICE_PERMISSION_SKILL_TYPES = {
  fba: ["amazon_fba", "ziniao_browser", "default"],
  replenishment: ["amazon_replenish", "default"],
  full_access: ["*"],
} as const satisfies Record<DesktopPermissionProfile, readonly string[]>;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const profileValue = (value: unknown): DesktopPermissionProfile | null => {
  if (value === null) return null;
  if (value === "fba" || value === "replenishment" || value === "full_access") {
    return value;
  }
  throw new Error("unknown device permission profile");
};

const nonNegativeInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
};

const exactSkillTypes = (
  value: unknown,
  profile: DesktopPermissionProfile | null,
): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("allowed_skill_types must be a string array");
  }
  const actual = value.map((item) => String(item).trim());
  if (new Set(actual).size !== actual.length) {
    throw new Error("allowed_skill_types contains duplicates");
  }
  const expected = profile === null ? [] : [...DEVICE_PERMISSION_SKILL_TYPES[profile]];
  if (actual.length !== expected.length || expected.some((item) => !actual.includes(item))) {
    throw new Error("allowed_skill_types does not match permission profile");
  }
  return expected;
};

export function parseServerDevicePermission(
  value: unknown,
  deviceId: string,
  verifiedAt: number,
): DesktopCloudPermissionSnapshot {
  const object = objectValue(value);
  if (!object) throw new Error("device permission response must be an object");
  const permissionProfile = profileValue(object.permission_profile);
  const permissionVersion = nonNegativeInteger(
    object.permission_version,
    "permission_version",
  );
  if (permissionProfile === null && permissionVersion !== 0) {
    throw new Error("unassigned device permission version must be zero");
  }
  if (permissionProfile !== null && permissionVersion < 1) {
    throw new Error("assigned device permission version must be positive");
  }
  return {
    device_id: deviceId,
    permission_profile: permissionProfile,
    permission_version: permissionVersion,
    allowed_skill_types: exactSkillTypes(object.allowed_skill_types, permissionProfile),
    verified_at: verifiedAt,
  };
}

export function parseStoredDevicePermission(
  value: unknown,
): DesktopCloudPermissionSnapshot | null {
  if (value === null || value === undefined) return null;
  try {
    const object = objectValue(value);
    if (!object || typeof object.device_id !== "string" || !object.device_id.trim()) return null;
    const snapshot = parseServerDevicePermission(
      {
        permission_profile: object.permission_profile,
        permission_version: object.permission_version,
        allowed_skill_types: object.allowed_skill_types,
      },
      object.device_id.trim(),
      nonNegativeInteger(object.verified_at, "verified_at"),
    );
    return snapshot.verified_at > 0 ? snapshot : null;
  } catch {
    return null;
  }
}

export function permissionSnapshotsEqual(
  left: DesktopCloudPermissionSnapshot,
  right: DesktopCloudPermissionSnapshot,
): boolean {
  return left.device_id === right.device_id
    && left.permission_profile === right.permission_profile
    && left.permission_version === right.permission_version
    && left.allowed_skill_types.length === right.allowed_skill_types.length
    && left.allowed_skill_types.every((item) => right.allowed_skill_types.includes(item));
}
