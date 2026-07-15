import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillCatalog, buildSkillIndexPrompt } from "../../src/tooling/skills";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skill context", () => {
  test("indexes allowed skill manifests and points the agent to their source", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "type: default", "description: Demo workflow",
      "commands:", "  - lxeskill demo run", "---", "# Demo", "",
    ].join("\n"), "utf8");
    mkdirSync(join(root, "skills", "blocked"), { recursive: true });
    writeFileSync(join(root, "skills", "blocked", "SKILL.md"), [
      "---", "name: blocked", "type: internal", "description: Hidden",
      "commands:", "  - lxeskill hidden run", "---", "",
    ].join("\n"), "utf8");
    const prompt = buildSkillIndexPrompt(root, { allowedTypes: new Set(["default"]) });
    expect(prompt).toContain("demo");
    expect(prompt).toContain("skills/demo/SKILL.md");
    expect(prompt).toContain("Commands: lxeskill demo run");
    expect(prompt).toContain("## lxeskill invocation contract");
    expect(prompt).toContain("exec.cwd instead");
    expect(prompt).not.toContain("blocked");
    expect(prompt).not.toContain("lxeskill hidden run");
  });

  test("prefers repository skills, refreshes by signature, and validates references", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-catalog-"));
    roots.push(root);
    const userRoot = join(root, "user-skills");
    mkdirSync(join(root, "skills", "demo", "references"), { recursive: true });
    mkdirSync(join(userRoot, "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "references", "help.md"), "help", "utf8");
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "type: default", "description: Repository version",
      "references:", "  - path: references/help.md", "---", "# Demo", "",
    ].join("\n"), "utf8");
    writeFileSync(join(userRoot, "demo", "SKILL.md"), "---\nname: demo\ndescription: User version\n---\n", "utf8");
    const catalog = new SkillCatalog(root, userRoot, { refreshIntervalMs: 0 });
    expect(catalog.get("demo")?.description).toBe("Repository version");
    expect(catalog.get("demo")?.references).toEqual([{ path: "references/help.md", description: "" }]);

    writeFileSync(join(root, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "type: default", "description: Repository version updated",
      "references:", "  - path: references/help.md", "---", "# Demo", "",
    ].join("\n"), "utf8");
    expect(catalog.get("demo")?.description).toBe("Repository version updated");

    mkdirSync(join(root, "skills", "broken"), { recursive: true });
    writeFileSync(join(root, "skills", "broken", "SKILL.md"), [
      "---", "name: broken", "references:", "  - path: ../outside.md", "---", "",
    ].join("\n"), "utf8");
    expect(() => catalog.list()).toThrow("skill reference escapes its root");
  });

  test("reads plural commands, accepts legacy command, and rejects duplicate ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skill-commands-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "plural"), { recursive: true });
    mkdirSync(join(root, "skills", "legacy"), { recursive: true });
    writeFileSync(join(root, "skills", "plural", "SKILL.md"), [
      "---", "name: plural", "commands:", "  - scripts.one", "  - scripts.two", "---", "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "skills", "legacy", "SKILL.md"), [
      "---", "name: legacy", "command: scripts.legacy", "---", "",
    ].join("\n"), "utf8");
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { refreshIntervalMs: 0 });
    expect(catalog.get("plural")?.commands).toEqual(["scripts.one", "scripts.two"]);
    expect(catalog.get("legacy")?.commands).toEqual(["scripts.legacy"]);
    mkdirSync(join(root, "skills", "conflict"), { recursive: true });
    writeFileSync(join(root, "skills", "conflict", "SKILL.md"), [
      "---", "name: conflict", "commands: [scripts.two]", "---", "",
    ].join("\n"), "utf8");
    expect(() => catalog.list()).toThrow("duplicate skill command scripts.two");
  });

  test("reuses immutable filtered snapshots until the lazy refresh window expires", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-snapshot-"));
    roots.push(root);
    const skillPath = join(root, "skills", "demo", "SKILL.md");
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(skillPath, [
      "---", "name: demo", "type: default", "description: Original", "---", "# Demo", "",
    ].join("\n"), "utf8");
    let now = 10_000;
    const catalog = new SkillCatalog(root, join(root, "missing-user"), {
      refreshIntervalMs: 1_000,
      now: () => now,
    });

    const original = catalog.snapshot();
    expect(original.names).toEqual(["demo"]);
    expect(original.modules).toEqual({ demo: "default" });
    expect(original.prompt).toContain("Original");
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.names)).toBe(true);
    expect(Object.isFrozen(original.modules)).toBe(true);

    writeFileSync(skillPath, [
      "---", "name: demo", "type: updated", "description: Updated and longer", "---", "# Demo", "",
    ].join("\n"), "utf8");
    expect(catalog.snapshot()).toBe(original);
    expect(catalog.get("demo")?.description).toBe("Original");

    now += 1_000;
    const updated = catalog.snapshot();
    expect(updated).not.toBe(original);
    expect(updated.modules).toEqual({ demo: "updated" });
    expect(updated.prompt).toContain("Updated and longer");
  });

  test("applies option changes immediately and keeps returned manifests isolated", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-filter-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "first"), { recursive: true });
    mkdirSync(join(root, "skills", "second"), { recursive: true });
    writeFileSync(join(root, "skills", "first", "SKILL.md"), [
      "---", "name: first", "type: default", "description: First", "commands: [scripts.first]", "---", "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "skills", "second", "SKILL.md"), [
      "---", "name: second", "type: internal", "description: Second", "---", "",
    ].join("\n"), "utf8");
    const catalog = new SkillCatalog(root, join(root, "missing-user"));

    const allowed = catalog.snapshot({ allowedTypes: new Set(["default"]) });
    const disabled = catalog.snapshot({
      allowedTypes: new Set(["default"]),
      disabledNames: new Set(["first"]),
    });
    expect(allowed.names).toEqual(["first"]);
    expect(disabled.names).toEqual([]);
    expect(catalog.snapshot({ allowedTypes: new Set(["default"]) })).toBe(allowed);

    const listed = catalog.list({ allowedTypes: new Set(["default"]) });
    listed[0]!.description = "mutated";
    listed[0]!.commands.push("scripts.mutated");
    const selected = catalog.get("first", { allowedTypes: new Set(["default"]) })!;
    expect(selected.description).toBe("First");
    expect(selected.commands).toEqual(["scripts.first"]);
    selected.description = "mutated again";
    expect(catalog.get("first")?.description).toBe("First");
  });

  test("does not publish a failed refresh and retries it on the next request", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-refresh-failure-"));
    roots.push(root);
    const skillPath = join(root, "skills", "demo", "SKILL.md");
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(skillPath, "---\nname: demo\ndescription: Valid\n---\n", "utf8");
    let now = 0;
    const catalog = new SkillCatalog(root, join(root, "missing-user"), {
      refreshIntervalMs: 1_000,
      now: () => now,
    });
    const valid = catalog.snapshot();

    writeFileSync(skillPath, "# missing frontmatter and deliberately longer\n", "utf8");
    now = 1_000;
    expect(() => catalog.snapshot()).toThrow("skill is missing YAML frontmatter");
    expect(valid.names).toEqual(["demo"]);
    expect(valid.prompt).toContain("Valid");

    writeFileSync(skillPath, "---\nname: demo\ndescription: Recovered\n---\n", "utf8");
    expect(catalog.snapshot().prompt).toContain("Recovered");
  });

  test("bounds filtered snapshot variants and evicts the oldest entry", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-cache-bound-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n", "utf8");
    const catalog = new SkillCatalog(root, join(root, "missing-user"));
    const firstOptions = { disabledNames: new Set(["unused-0"]) };
    const first = catalog.snapshot(firstOptions);
    for (let index = 1; index <= 32; index += 1) {
      catalog.snapshot({ disabledNames: new Set([`unused-${index}`]) });
    }
    expect(catalog.snapshot(firstOptions)).not.toBe(first);
  });
});
