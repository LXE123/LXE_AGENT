import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingPathPolicy } from "../../src/tooling/coding/path-policy";
import { workspaceFor } from "../workspace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CodingPathPolicy", () => {
  test("keeps read, write, send, and executable cwd capabilities distinct", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lxe-path-workspace-"));
    const resourceRoot = mkdtempSync(join(tmpdir(), "lxe-path-resource-"));
    const dataRoot = mkdtempSync(join(tmpdir(), "lxe-path-data-"));
    const home = mkdtempSync(join(tmpdir(), "lxe-path-home-"));
    roots.push(workspaceRoot, resourceRoot, dataRoot, home);
    const repositorySkillsRoot = join(resourceRoot, "skills");
    const skillRoot = join(repositorySkillsRoot, "demo");
    const skillDocument = join(skillRoot, "SKILL.md");
    const skillAsset = join(skillRoot, "assets", "guide.txt");
    const runtimeArtifactRoot = join(dataRoot, "artifacts");
    const runtimeArtifact = join(runtimeArtifactRoot, "report.txt");
    const workspaceArtifact = join(workspaceRoot, "artifacts", "local.txt");
    const normalFile = join(workspaceRoot, "notes.txt");
    const environmentFile = join(workspaceRoot, ".env");
    const databaseFile = join(workspaceRoot, "var", "db", "agent.sqlite3");
    mkdirSync(join(skillRoot, "assets"), { recursive: true });
    mkdirSync(runtimeArtifactRoot, { recursive: true });
    mkdirSync(join(workspaceRoot, "artifacts"), { recursive: true });
    mkdirSync(join(workspaceRoot, "var", "db"), { recursive: true });
    for (const path of [skillDocument, skillAsset, runtimeArtifact, workspaceArtifact, normalFile, environmentFile, databaseFile]) {
      writeFileSync(path, "content\n");
    }

    const workspace = workspaceFor(workspaceRoot);
    const policy = new CodingPathPolicy({ repositorySkillsRoot, artifactRoot: runtimeArtifactRoot, homeDirectory: home });

    expect(policy.resolveReadable(workspace, normalFile).path).toBe(normalFile);
    expect(policy.resolveReadable(workspace, environmentFile).path).toBe(environmentFile);
    expect(policy.resolveReadable(workspace, databaseFile).path).toBe(databaseFile);
    expect(policy.resolveReadable(workspace, skillDocument).path).toBe(skillDocument);
    expect(policy.resolveReadable(workspace, runtimeArtifact).path).toBe(runtimeArtifact);
    expect(policy.resolveWritable(workspace, normalFile)).toBe(normalFile);
    expect(policy.resolveExecutableCwd(workspace, ".")).toBe(workspaceRoot);
    expect(() => policy.resolveWritable(workspace, environmentFile)).toThrow("protected workspace file");
    expect(() => policy.resolveWritable(workspace, databaseFile)).toThrow("protected workspace directory");
    expect(() => policy.resolveWritable(workspace, skillDocument)).toThrow("escapes workspace");
    expect(() => policy.resolveWritable(workspace, runtimeArtifact)).toThrow("escapes workspace");
    expect(() => policy.resolveExecutableCwd(workspace, skillRoot)).toThrow("escapes workspace");

    expect(() => policy.assertSendable(workspace, policy.resolveReadable(workspace, normalFile)))
      .toThrow("skill assets");
    expect(() => policy.assertSendable(workspace, policy.resolveReadable(workspace, environmentFile)))
      .toThrow("skill assets");
    expect(() => policy.assertSendable(workspace, policy.resolveReadable(workspace, databaseFile)))
      .toThrow("skill assets");
    expect(() => policy.assertSendable(workspace, policy.resolveReadable(workspace, skillDocument)))
      .toThrow("skill assets");
    expect(() => policy.assertSendable(workspace, policy.resolveReadable(workspace, workspaceArtifact)))
      .not.toThrow();
    expect(() => policy.assertSendable(workspace, policy.resolveReadable(workspace, skillAsset)))
      .not.toThrow();
    expect(() => policy.assertSendable(workspace, policy.resolveReadable(workspace, runtimeArtifact)))
      .not.toThrow();
  });

  test("rejects traversal, symlink escapes, and missing descendants below symlink parents", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lxe-path-workspace-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "lxe-path-outside-"));
    roots.push(workspaceRoot, outsideRoot);
    writeFileSync(join(outsideRoot, "secret.txt"), "secret\n");
    symlinkSync(outsideRoot, join(workspaceRoot, "escaped"), process.platform === "win32" ? "junction" : "dir");
    const workspace = workspaceFor(workspaceRoot);
    const policy = new CodingPathPolicy();

    expect(() => policy.resolveReadable(workspace, "../outside.txt")).toThrow("approved read-only roots");
    expect(() => policy.resolveWritable(workspace, "../outside.txt")).toThrow("escapes workspace");
    expect(() => policy.resolveExecutableCwd(workspace, "../outside")).toThrow("escapes workspace");
    expect(() => policy.resolveReadable(workspace, "escaped/secret.txt")).toThrow("approved read-only roots");
    expect(() => policy.resolveWritable(workspace, "escaped/new.txt")).toThrow("escapes workspace");
    expect(() => policy.resolveExecutableCwd(workspace, "escaped/missing")).toThrow("escapes workspace");
  });
});
