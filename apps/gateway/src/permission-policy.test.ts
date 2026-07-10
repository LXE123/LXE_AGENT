import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PermissionPolicyError,
  buildPermissionPolicy,
  canUserAccessBot,
  loadPermissionPolicy,
  permissionPolicyPath,
  resolveBotId,
  resolvePermissionUserId,
} from "./permission-policy";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const valid = () => ({
  bots: {
    PRIMARY: { key: "shared", app_id: "app-1", skill_types: ["default"] },
    BACKUP: { key: "shared", app_id: "app-2", skill_types: ["default"] },
  },
  users: {
    Alice: { union_id: "union-1", allow: ["PRIMARY"] },
    Admin: { union_id: "union-admin", allow: ["*"] },
  },
});

describe("permission policy", () => {
  test("allows aliases through shared keys, wildcard users, and denies unknown bots", () => {
    const policy = buildPermissionPolicy(valid(), "policy.yaml");
    expect(canUserAccessBot(policy, "union-1", "app-2")).toBe(true);
    expect(canUserAccessBot(policy, "union-admin", "app-1")).toBe(true);
    expect(canUserAccessBot(policy, "union-admin", "unknown")).toBe(false);
  });

  test("uses Python-compatible bot and union-id fallbacks", () => {
    expect(
      resolveBotId({
        platform: "feishu",
        source: { extra: { bot_app_id: "from-extra" } },
        raw_data: { app_id: "from-raw" },
      }),
    ).toBe("from-raw");
    expect(resolveBotId({ platform: "feishu" }, "configured-app")).toBe("configured-app");
    expect(
      resolvePermissionUserId({ union_id: "direct", raw_data: { sender_union_id: "raw" } }),
    ).toBe("direct");
    expect(resolvePermissionUserId({ raw_data: { sender_union_id: "raw" } })).toBe("raw");
  });

  const invalidCases: Array<[string, unknown, string]> = [
    ["missing bots", { users: {} }, "bots must be a mapping"],
    ["empty bots", { bots: {}, users: {} }, "bots must not be empty"],
    ["duplicate app ids", (() => { const x = valid(); x.bots.BACKUP.app_id = "app-1"; return x; })(), "duplicate bot app_id"],
    ["inconsistent shared skills", (() => { const x = valid(); x.bots.BACKUP.skill_types = ["other"]; return x; })(), "must match shared permission key"],
    ["unknown alias", (() => { const x = valid(); x.users.Alice.allow = ["UNKNOWN"]; return x; })(), "references unknown bot alias"],
    ["wildcard mixed", (() => { const x = valid(); x.users.Alice.allow = ["*", "PRIMARY"]; return x; })(), "cannot mix"],
    ["duplicate union", (() => { const x = valid(); x.users.Admin.union_id = "union-1"; return x; })(), "duplicate user union_id"],
    ["duplicate list value", (() => { const x = valid(); x.bots.PRIMARY.skill_types = ["default", "default"]; return x; })(), "contains duplicate value"],
    ["empty list value", (() => { const x = valid(); x.users.Alice.allow = [""]; return x; })(), "contains an empty value"],
  ];
  test.each(invalidCases)("rejects %s", (_name: string, value: unknown, message: string) => {
    expect(() => buildPermissionPolicy(value, "policy.yaml")).toThrow(message);
  });

  test("rejects missing files, invalid roots, and duplicate YAML keys", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-policy-"));
    roots.push(root);
    expect(() => loadPermissionPolicy(join(root, "missing.yaml"))).toThrow("file not found");

    const path = join(root, "policy.yaml");
    writeFileSync(path, "- not\n- a mapping\n", "utf8");
    expect(() => loadPermissionPolicy(path)).toThrow("root must be a mapping");
    writeFileSync(path, "bots:\n  A: {}\n  A: {}\nusers: {}\n", "utf8");
    expect(() => loadPermissionPolicy(path)).toThrow(PermissionPolicyError);
    expect(() => loadPermissionPolicy(path)).toThrow("duplicate");
  });

  test("resolves explicit, environment, then project-default policy paths", () => {
    expect(
      permissionPolicyPath({
        path: " ~/explicit.yaml ",
        env: { LXE_PERMISSION_POLICY_PATH: "/env/policy.yaml" },
        projectRoot: "/repo",
        home: "/home/tester",
      }),
    ).toBe("/home/tester/explicit.yaml");
    expect(
      permissionPolicyPath({
        env: { LXE_PERMISSION_POLICY_PATH: "~/env.yaml" },
        projectRoot: "/repo",
        home: "/home/tester",
      }),
    ).toBe("/home/tester/env.yaml");
    expect(permissionPolicyPath({ env: {}, projectRoot: "/repo" })).toBe(
      "/repo/config/permission_policy.yaml",
    );
  });
});
