import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  approvedSkillFile,
  loadResourceScope,
  scopeEntryForPath,
} from "./desktop-resource-scope";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("desktop resource scope", () => {
  test("assigns every packaged owner without overlapping targets", () => {
    const scope = loadResourceScope(repositoryRoot);
    expect(scopeEntryForPath(scope, "agent/SOUL.md", "win32-x64")).toMatchObject({
      owner: "bun-agent-runtime",
      policy: "editable",
    });
    expect(scopeEntryForPath(scope, "runtime/python/python.exe", "win32-x64")).toMatchObject({
      owner: "managed-python-runtime",
      policy: "immutable",
    });
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
  });

  test("declares the exact immutable configuration whitelist", () => {
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
});
