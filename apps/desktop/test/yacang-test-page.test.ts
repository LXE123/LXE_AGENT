import { describe, expect, test } from "bun:test";
import { buildYacangTestPageEnvironment } from "../src/main/yacang-test-page";

describe("DesktopYacangTestPageService", () => {
  test("passes Desktop secure configuration to the Python child without enabling production", () => {
    const environment = buildYacangTestPageEnvironment({
      pythonPath: "python",
      dataRoot: "C:\\data",
      managedPath: "C:\\managed",
      skillScope: async () => ["yacang-export-workflow-map"],
      environment: () => ({
        LXE_YACANG_MOBILE: "13800138000",
        LXE_YACANG_PASSWORD: "yacang-secret",
      }),
    }, ["yacang-export-workflow-map"], {
      PATH: "C:\\Windows",
      LXE_YACANG_PROD_ENABLED: "false",
    });

    expect(environment).toMatchObject({
      LXE_YACANG_MOBILE: "13800138000",
      LXE_YACANG_PASSWORD: "yacang-secret",
      LXE_YACANG_PROD_ENABLED: "false",
      LXE_DATA_ROOT: "C:\\data",
      LXESKILL_SKILL_SCOPE: "yacang-export-workflow-map",
    });
  });

  test("uses the current filtered Skill names and keeps an empty scope fail-closed", () => {
    const options = {
      pythonPath: "python",
      dataRoot: "C:\\data",
      managedPath: "C:\\managed",
      skillScope: async () => [],
      environment: () => ({}),
    };

    expect(buildYacangTestPageEnvironment(options, ["other-skill"], {
      LXESKILL_SKILL_SCOPE: "stale-skill",
    }).LXESKILL_SKILL_SCOPE).toBe("other-skill");
    expect(buildYacangTestPageEnvironment(options, [], {
      LXESKILL_SKILL_SCOPE: "stale-skill",
    }).LXESKILL_SKILL_SCOPE).toBe("");
  });
});
