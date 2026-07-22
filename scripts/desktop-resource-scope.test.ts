import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  approvedConstructiveResourcePath,
  approvedSkillFile,
  prohibitedPythonRuntimePath,
  readResourceScope,
  requireResourceSourceFile,
  scopeEntryForPath,
  validateSelectedSkills,
  validateResourceScope,
} from "./desktop-resource-scope";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

const temporaryRepository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-resource-scope-"));
  temporaryRoots.push(root);
  return root;
};

const writeTemporaryFile = (root: string, path: string, content: string): void => {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop resource scope", () => {
  test("assigns every packaged owner without overlapping targets", () => {
    const scope = validateResourceScope(repositoryRoot);
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

  test("keeps scope reading separate from complete declaration validation", () => {
    const scope = readResourceScope(repositoryRoot);
    expect(scope.schema_version).toBe(2);
    expect(validateResourceScope(repositoryRoot, structuredClone(scope))).toEqual(scope);

    const incompleteOwner = structuredClone(scope);
    incompleteOwner.resources[0]!.owner = "";
    expect(() => validateResourceScope(repositoryRoot, incompleteOwner)).toThrow("entry is incomplete");

    const overlappingTarget = structuredClone(scope);
    overlappingTarget.resources[1]!.target = "agent";
    expect(() => validateResourceScope(repositoryRoot, overlappingTarget)).toThrow("targets overlap");

    const invalidKind = structuredClone(scope);
    invalidKind.resources[0]!.source.kind = "unknown";
    expect(() => validateResourceScope(repositoryRoot, invalidKind)).toThrow("source kind is invalid");

    const prohibitedTarget = structuredClone(scope);
    prohibitedTarget.resources[0]!.target = "docs/internal.md";
    expect(() => validateResourceScope(repositoryRoot, prohibitedTarget)).toThrow("target is prohibited");
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

  test("rejects malformed, duplicate, and invalid Skill declarations", () => {
    const missingFrontmatterRoot = temporaryRepository();
    writeTemporaryFile(missingFrontmatterRoot, "skills/one/SKILL.md", "No frontmatter\n");
    expect(() => validateSelectedSkills(missingFrontmatterRoot, ["skills/one/SKILL.md"]))
      .toThrow("missing YAML frontmatter");

    const duplicateRoot = temporaryRepository();
    const duplicateManifest = "---\nname: duplicate\n---\n";
    writeTemporaryFile(duplicateRoot, "skills/one/SKILL.md", duplicateManifest);
    writeTemporaryFile(duplicateRoot, "skills/two/SKILL.md", duplicateManifest);
    expect(() => validateSelectedSkills(duplicateRoot, [
      "skills/one/SKILL.md",
      "skills/two/SKILL.md",
    ])).toThrow("Skill name is duplicated");

    const referenceRoot = temporaryRepository();
    writeTemporaryFile(
      referenceRoot,
      "skills/one/SKILL.md",
      "---\nname: one\nreferences:\n  - references/missing.md\n---\n",
    );
    expect(() => validateSelectedSkills(referenceRoot, ["skills/one/SKILL.md"]))
      .toThrow("reference is missing, escapes its Skill, or is outside the whitelist");
  });

  test("declares the exact production configuration whitelist", () => {
    const scope = validateResourceScope(repositoryRoot);
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
