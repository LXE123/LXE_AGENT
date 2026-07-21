import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  approvedConstructiveResourcePath,
  approvedSkillFile,
  loadResourceScope,
  prohibitedPythonRuntimePath,
  requireResourceSourceFile,
  scopeEntryForPath,
  validateSelectedSkills,
} from "./desktop-resource-scope";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("desktop resource scope", () => {
  test("assigns every packaged owner without overlapping targets", () => {
    const scope = loadResourceScope(repositoryRoot);
    expect(scopeEntryForPath(scope, "agent/SOUL.md", "win32-x64")).toMatchObject({
      owner: "bun-agent-runtime",
    });
    expect(scopeEntryForPath(scope, "runtime/python/python.exe", "win32-x64")).toMatchObject({
      owner: "managed-python-runtime",
    });
    const rawScope = readFileSync(resolve(repositoryRoot, "config/desktop-packaging/resource-scope.json"), "utf8");
    expect(rawScope).not.toMatch(/"(?:policy|integrity)"/u);
    expect(() => scopeEntryForPath(scope, "docs/internal.md", "win32-x64"))
      .toThrow("exactly one owner");
  });

  test("selects only approved Skill payloads", () => {
    const result = Bun.spawnSync(["git", "ls-files", "-z", "--", "skills"], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const tracked = new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
    const approved = tracked.filter((path) => approvedSkillFile(repositoryRoot, path));
    expect(approved.some((path) => path.endsWith("/SKILL.md"))).toBe(true);
    expect(approved).toContain("skills/dws/references/global-reference.md");
    expect(approved).not.toContain("skills/larksuite-cli/UPSTREAM.md");
    expect(approved.some((path) => path.endsWith("_test.py"))).toBe(false);
    validateSelectedSkills(repositoryRoot, approved);
  });

  test("declares the exact production configuration whitelist", () => {
    const scope = loadResourceScope(repositoryRoot);
    const config = scope.resources.find((entry) => entry.id === "config");
    expect(config?.source.paths).toEqual([
      "config/llm/auth-profiles.json",
      "config/llm/providers/deepseek.json",
      "config/llm/providers/glm.json",
      "config/llm/providers/kimi-coding.json",
      "config/runtime.env",
      "config/permission_policy.yaml",
      "config/mcp_servers.default.yaml",
    ]);
    expect(readFileSync(resolve(repositoryRoot, "config/mcp_servers.default.yaml"), "utf8"))
      .toContain("mcpServers:");
  });

  test("constructs resources without development, business, or cache files", () => {
    expect(approvedConstructiveResourcePath("dashboard/assets/index.js")).toBe(true);
    expect(approvedConstructiveResourcePath("dashboard/assets/index.js.map")).toBe(false);
    expect(approvedConstructiveResourcePath("dashboard/src/main.tsx")).toBe(false);
    expect(approvedConstructiveResourcePath("skills/demo/scripts/tool.ts")).toBe(true);
    expect(approvedConstructiveResourcePath("runtime/node/node_modules/pkg/tests/example.js")).toBe(false);
    expect(approvedConstructiveResourcePath("runtime/python/Lib/site-packages/pkg/fixtures/input.json")).toBe(false);
    expect(approvedConstructiveResourcePath("runtime/node/node_modules/pkg/.env.production")).toBe(false);
    expect(approvedConstructiveResourcePath("runtime/node/node_modules/pkg/.npmrc")).toBe(false);
    expect(approvedConstructiveResourcePath("runtime/node/node_modules/pkg/auth.json")).toBe(false);
    expect(approvedConstructiveResourcePath("runtime/python/credentials.json")).toBe(false);
    expect(approvedConstructiveResourcePath("runtime/python/.lxe-lxeskill-ready.json")).toBe(false);
    expect(approvedConstructiveResourcePath("runtime/node/npm-cache/_logs/install.log")).toBe(false);
    expect(approvedConstructiveResourcePath("docs/internal.md")).toBe(false);
    expect(approvedConstructiveResourcePath("data/business.xlsx")).toBe(false);
    expect(prohibitedPythonRuntimePath("runtime/python/Lib/__pycache__/__future__.cpython-312.pyc"))
      .toBe(true);
    expect(prohibitedPythonRuntimePath("runtime\\python\\Lib\\site-packages\\demo.pyo"))
      .toBe(true);
    expect(prohibitedPythonRuntimePath("runtime/python/Lib/__future__.py")).toBe(false);
  });

  test("reports the exact missing constructive source path", () => {
    const missing = join(repositoryRoot, "missing-desktop-resource.json");
    expect(() => requireResourceSourceFile(missing))
      .toThrow(`Desktop resource source file is missing: ${missing}`);
  });
});
