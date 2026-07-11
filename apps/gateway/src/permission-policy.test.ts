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

  test.each([
    ["bot key", false, "key must not be empty"],
    ["bot app id", 0, "app_id must not be empty"],
    ["user union id", false, "union_id must not be empty"],
  ])("treats falsy scalar %s as empty", (_name: string, value: unknown, message: string) => {
    const data = structuredClone(valid()) as unknown as {
      bots: Record<string, { key: unknown; app_id: unknown; skill_types: unknown[] }>;
      users: Record<string, { union_id: unknown; allow: unknown[] }>;
    };
    if (_name === "bot key") data.bots.PRIMARY!.key = value;
    if (_name === "bot app id") data.bots.PRIMARY!.app_id = value;
    if (_name === "user union id") data.users.Alice!.union_id = value;
    expect(() => buildPermissionPolicy(data, "policy.yaml")).toThrow(message);
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

  test("rejects falsy YAML scalars as empty identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-policy-falsy-"));
    roots.push(root);
    const path = join(root, "policy.yaml");
    writeFileSync(
      path,
      [
        "bots:",
        "  PRIMARY:",
        "    key: false",
        "    app_id: 0",
        "    skill_types: [default]",
        "users:",
        "  Alice:",
        "    union_id: false",
        "    allow: [PRIMARY]",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(() => loadPermissionPolicy(path)).toThrow("key must not be empty");
  });

  test("resolves explicit, environment, then project-default policy paths", () => {
    expect(
      permissionPolicyPath({
        path: " ~/explicit.yaml ",
        env: { LXE_PERMISSION_POLICY_PATH: "/env/policy.yaml" },
        projectRoot: "/repo",
        home: "/home/tester",
      }),
    ).toBe(join("/home/tester", "explicit.yaml"));
    expect(
      permissionPolicyPath({
        env: { LXE_PERMISSION_POLICY_PATH: "~/env.yaml" },
        projectRoot: "/repo",
        home: "/home/tester",
      }),
    ).toBe(join("/home/tester", "env.yaml"));
    expect(permissionPolicyPath({ env: {}, projectRoot: "/repo" })).toBe(
      join("/repo", "config", "permission_policy.yaml"),
    );
  });
});
