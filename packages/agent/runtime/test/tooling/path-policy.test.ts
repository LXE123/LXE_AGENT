import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CodingPathPolicy } from "../../src/tooling/coding/path-policy";
import { workspaceFor } from "../workspace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CodingPathPolicy", () => {
  test("classifies known roots without restricting host reads, writes, or executable cwd", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lxe-path-workspace-"));
    const resourceRoot = mkdtempSync(join(tmpdir(), "lxe-path-resource-"));
    const dataRoot = mkdtempSync(join(tmpdir(), "lxe-path-data-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "lxe-path-outside-"));
    const home = mkdtempSync(join(tmpdir(), "lxe-path-home-"));
    roots.push(workspaceRoot, resourceRoot, dataRoot, outsideRoot, home);
    const repositorySkillsRoot = join(resourceRoot, "skills");
    const skillRoot = join(repositorySkillsRoot, "demo");
    const skillDocument = join(skillRoot, "SKILL.md");
    const runtimeArtifactRoot = join(dataRoot, "artifacts");
    const runtimeArtifact = join(runtimeArtifactRoot, "report.txt");
    const normalFile = join(workspaceRoot, "notes.txt");
    const environmentFile = join(workspaceRoot, ".env");
    const databaseFile = join(workspaceRoot, "var", "db", "agent.sqlite3");
    const outsideFile = join(outsideRoot, "outside.txt");
    const homeFile = join(home, "home.txt");
    mkdirSync(skillRoot, { recursive: true });
    mkdirSync(runtimeArtifactRoot, { recursive: true });
    mkdirSync(join(workspaceRoot, "var", "db"), { recursive: true });
    for (const path of [skillDocument, runtimeArtifact, normalFile, environmentFile, databaseFile, outsideFile, homeFile]) {
      writeFileSync(path, "content\n");
    }

    const workspace = workspaceFor(workspaceRoot);
    const policy = new CodingPathPolicy({ repositorySkillsRoot, artifactRoot: runtimeArtifactRoot, homeDirectory: home });

    expect(policy.resolveReadable(workspace, normalFile)).toMatchObject({ path: normalFile, scope: { kind: "workspace" } });
    expect(policy.resolveReadable(workspace, skillDocument)).toMatchObject({ path: skillDocument, scope: { kind: "skills" } });
    expect(policy.resolveReadable(workspace, runtimeArtifact)).toMatchObject({ path: runtimeArtifact, scope: { kind: "artifacts" } });
    expect(policy.resolveReadable(workspace, outsideFile)).toMatchObject({ path: outsideFile, scope: { kind: "host" } });
    expect(policy.resolveReadable(workspace, "~/home.txt").path).toBe(homeFile);
    expect(policy.resolveWritable(workspace, environmentFile)).toBe(environmentFile);
    expect(policy.resolveWritable(workspace, databaseFile)).toBe(databaseFile);
    expect(policy.resolveWritable(workspace, outsideFile)).toBe(outsideFile);
    expect(policy.resolveExecutableCwd(workspace, skillRoot)).toBe(skillRoot);
    expect(policy.resolveExecutableCwd(workspace, outsideRoot)).toBe(outsideRoot);
  });

  test("allows traversal and symlinks to resolve through the host filesystem", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lxe-path-workspace-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "lxe-path-outside-"));
    roots.push(workspaceRoot, outsideRoot);
    const outsideFile = join(outsideRoot, "secret.txt");
    writeFileSync(outsideFile, "secret\n");
    const escapedRoot = join(workspaceRoot, "escaped");
    symlinkSync(outsideRoot, escapedRoot, process.platform === "win32" ? "junction" : "dir");
    const workspace = workspaceFor(workspaceRoot);
    const policy = new CodingPathPolicy();
    const relativeOutside = relative(workspaceRoot, outsideFile);

    expect(policy.resolveReadable(workspace, relativeOutside)).toMatchObject({ path: outsideFile, scope: { kind: "host" } });
    expect(policy.resolveWritable(workspace, relativeOutside)).toBe(outsideFile);
    expect(policy.resolveExecutableCwd(workspace, relative(workspaceRoot, outsideRoot))).toBe(outsideRoot);
    expect(policy.resolveReadable(workspace, "escaped/secret.txt")).toMatchObject({
      path: join(escapedRoot, "secret.txt"),
      scope: { kind: "host" },
    });
    expect(policy.resolveWritable(workspace, "escaped/new.txt")).toBe(join(escapedRoot, "new.txt"));
    expect(policy.resolveExecutableCwd(workspace, "escaped/missing")).toBe(join(escapedRoot, "missing"));
  });
});
