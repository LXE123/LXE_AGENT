import type { DesktopCloudPermissionSnapshot } from "@lxe/desktop-protocol";

const PERMISSION_RESPONSE_SCHEMA_V2 = "lxe.device-permission.v2";
const SAFE_PROFILE_ID = /^[a-z][a-z0-9_]{0,31}$/u;
const SAFE_GRANT_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_GRANTS = 64;

const LEGACY_PERMISSION_PROFILES = {
  fba: {
    skillTypes: ["amazon_fba", "ziniao_browser", "default"],
    labels: { "zh-CN": "FBA", "en-US": "FBA" },
    desktopFeatures: ["erp_dashboard"],
  },
  replenishment: {
    skillTypes: ["amazon_replenish", "default"],
    labels: { "zh-CN": "备货", "en-US": "Replenishment" },
    desktopFeatures: [],
  },
  full_access: {
    skillTypes: ["*"],
    labels: { "zh-CN": "全部业务", "en-US": "Full access" },
    desktopFeatures: ["erp_dashboard"],
  },
} as const;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const nonNegativeInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
};

const legacyProfile = (value: unknown): keyof typeof LEGACY_PERMISSION_PROFILES | null => {
  if (value === null) return null;
  if (value === "fba" || value === "replenishment" || value === "full_access") return value;
  throw new Error("unknown legacy device permission profile");
};

const exactLegacySkillTypes = (
  value: unknown,
  profile: keyof typeof LEGACY_PERMISSION_PROFILES | null,
): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("allowed_skill_types must be a string array");
  }
  const actual = value.map((item) => String(item).trim());
  if (new Set(actual).size !== actual.length) {
    throw new Error("allowed_skill_types contains duplicates");
  }
  const expected = profile === null ? [] : [...LEGACY_PERMISSION_PROFILES[profile].skillTypes];
  if (actual.length !== expected.length || expected.some((item) => !actual.includes(item))) {
    throw new Error("allowed_skill_types does not match legacy permission profile");
  }
  return expected;
};

const genericNames = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length > MAX_GRANTS) {
    throw new Error(`${label} must be an array with at most ${MAX_GRANTS} entries`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string") throw new Error(`${label} must contain strings`);
    const normalized = item.trim();
    if (normalized !== "*" && !SAFE_GRANT_NAME.test(normalized)) {
      throw new Error(`${label} contains an invalid name`);
    }
    return normalized;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  if (result.includes("*") && result.length !== 1) {
    throw new Error(`${label} wildcard must be the only grant`);
  }
  return result;
};

const profileLabels = (value: unknown): Record<string, string> => {
  const labels = objectValue(value);
  if (!labels) throw new Error("profile labels must be an object");
  const result: Record<string, string> = {};
  for (const locale of ["zh-CN", "en-US"] as const) {
    const label = labels[locale];
    if (typeof label !== "string" || !label.trim() || label.trim().length > 64) {
      throw new Error(`profile label ${locale} is invalid`);
    }
    result[locale] = label.trim();
  }
  return result;
};

export function parseServerDevicePermission(
  value: unknown,
  deviceId: string,
  verifiedAt: number,
): DesktopCloudPermissionSnapshot {
  const object = objectValue(value);
  if (!object) throw new Error("device permission response must be an object");
  const permissionProfile = legacyProfile(object.permission_profile);
  const permissionVersion = nonNegativeInteger(object.permission_version, "permission_version");
  if (permissionProfile === null && permissionVersion !== 0) {
    throw new Error("unassigned device permission version must be zero");
  }
  if (permissionProfile !== null && permissionVersion < 1) {
    throw new Error("assigned device permission version must be positive");
  }
  const legacy = permissionProfile === null ? undefined : LEGACY_PERMISSION_PROFILES[permissionProfile];
  return {
    device_id: deviceId,
    permission_schema: 1,
    permission_profile: permissionProfile,
    permission_version: permissionVersion,
    profile_revision: permissionProfile === null ? 0 : 1,
    profile_labels: legacy ? { ...legacy.labels } : {},
    allowed_skill_types: exactLegacySkillTypes(object.allowed_skill_types, permissionProfile),
    desktop_features: legacy ? [...legacy.desktopFeatures] : [],
    verified_at: verifiedAt,
  };
}

export function parseServerDevicePermissionV2(
  value: unknown,
  deviceId: string,
  verifiedAt: number,
): DesktopCloudPermissionSnapshot {
  const object = objectValue(value);
  if (!object) throw new Error("device permission v2 response must be an object");
  if (object.response_schema !== PERMISSION_RESPONSE_SCHEMA_V2) {
    throw new Error("unsupported device permission response schema");
  }
  const assignmentVersion = nonNegativeInteger(object.assignment_version, "assignment_version");
  const grants = objectValue(object.grants);
  if (!grants) throw new Error("device permission grants must be an object");
  const skillTypes = genericNames(grants.skill_types, "skill_types");
  const desktopFeatures = genericNames(grants.desktop_features, "desktop_features");
  if (object.profile === null) {
    if (assignmentVersion !== 0 || skillTypes.length || desktopFeatures.length) {
      throw new Error("unassigned device permission v2 response is inconsistent");
    }
    return {
      device_id: deviceId,
      permission_schema: 2,
      permission_profile: null,
      permission_version: 0,
      profile_revision: 0,
      profile_labels: {},
      allowed_skill_types: [],
      desktop_features: [],
      verified_at: verifiedAt,
    };
  }
  const profile = objectValue(object.profile);
  if (!profile || typeof profile.id !== "string" || !SAFE_PROFILE_ID.test(profile.id)) {
    throw new Error("device permission profile id is invalid");
  }
  if (assignmentVersion < 1) throw new Error("assigned permission version must be positive");
  return {
    device_id: deviceId,
    permission_schema: 2,
    permission_profile: profile.id,
    permission_version: assignmentVersion,
    profile_revision: positiveInteger(profile.revision, "profile revision"),
    profile_labels: profileLabels(profile.labels),
    allowed_skill_types: skillTypes,
    desktop_features: desktopFeatures,
    verified_at: verifiedAt,
  };
}

export function parseStoredDevicePermission(value: unknown): DesktopCloudPermissionSnapshot | null {
  if (value === null || value === undefined) return null;
  try {
    const object = objectValue(value);
    if (!object || typeof object.device_id !== "string" || !object.device_id.trim()) return null;
    const verifiedAt = nonNegativeInteger(object.verified_at, "verified_at");
    if (verifiedAt < 1) return null;
    if (object.permission_schema === 2) {
      const snapshot = parseServerDevicePermissionV2({
        response_schema: PERMISSION_RESPONSE_SCHEMA_V2,
        assignment_version: object.permission_version,
        profile: object.permission_profile === null ? null : {
          id: object.permission_profile,
          revision: object.profile_revision,
          labels: object.profile_labels,
        },
        grants: {
          skill_types: object.allowed_skill_types,
          desktop_features: object.desktop_features,
        },
      }, object.device_id.trim(), verifiedAt);
      return snapshot;
    }
    return parseServerDevicePermission({
      permission_profile: object.permission_profile,
      permission_version: object.permission_version,
      allowed_skill_types: object.allowed_skill_types,
    }, object.device_id.trim(), verifiedAt);
  } catch {
    return null;
  }
}

const sameStrings = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const sameLabels = (left: Record<string, string>, right: Record<string, string>): boolean =>
  left["zh-CN"] === right["zh-CN"] && left["en-US"] === right["en-US"];

export function permissionSnapshotsEqual(
  left: DesktopCloudPermissionSnapshot,
  right: DesktopCloudPermissionSnapshot,
): boolean {
  return left.device_id === right.device_id
    && left.permission_schema === right.permission_schema
    && left.permission_profile === right.permission_profile
    && left.permission_version === right.permission_version
    && left.profile_revision === right.profile_revision
    && sameLabels(left.profile_labels, right.profile_labels)
    && sameStrings(left.allowed_skill_types, right.allowed_skill_types)
    && sameStrings(left.desktop_features, right.desktop_features);
}

export function legacySnapshotCanUpgrade(
  previous: DesktopCloudPermissionSnapshot,
  next: DesktopCloudPermissionSnapshot,
): boolean {
  return previous.permission_schema === 1
    && next.permission_schema === 2
    && previous.permission_profile === next.permission_profile
    && previous.permission_version === next.permission_version
    && sameStrings(previous.allowed_skill_types, next.allowed_skill_types);
}
