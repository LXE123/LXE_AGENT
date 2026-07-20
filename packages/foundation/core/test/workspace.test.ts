import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertWorkspaceAvailable,
  resolveWorkspaceContext,
  sameWorkspaceContext,
  workspaceContextFrom,
} from "../src/workspace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
};

describe("WorkspaceContext resolution", () => {
  test("never falls back to the process cwd for an empty or relative directory", () => {
    expect(() => resolveWorkspaceContext("")).toThrow("absolute path");
    expect(() => resolveWorkspaceContext("relative/workspace")).toThrow("absolute path");
    expect(() => workspaceContextFrom({ directory: "relative/workspace", worktree: "/workspace" }))
      .toThrow("workspace.directory must be an absolute path");
    expect(() => workspaceContextFrom({ directory: "/workspace", worktree: "relative/workspace" }))
      .toThrow("workspace.worktree must be an absolute path");
  });

  test("uses a Git root for nested directories and the directory itself outside Git", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-workspace-git-"));
    const plain = mkdtempSync(join(tmpdir(), "lxe-workspace-plain-"));
    roots.push(root, plain);
    git(root, "init", "--quiet");
    const nested = join(root, "目录 with spaces", "child");
    mkdirSync(nested, { recursive: true });

    expect(resolveWorkspaceContext(nested)).toEqual({
      directory: realpathSync.native(nested),
      worktree: realpathSync.native(root),
    });
    expect(resolveWorkspaceContext(plain)).toEqual({
      directory: realpathSync.native(plain),
      worktree: realpathSync.native(plain),
    });
  });

  test("recognizes an independent Git worktree instead of the main checkout", () => {
    const repository = mkdtempSync(join(tmpdir(), "lxe-workspace-repository-"));
    const worktree = mkdtempSync(join(tmpdir(), "lxe-workspace-linked-"));
    rmSync(worktree, { recursive: true, force: true });
    roots.push(repository, worktree);
    git(repository, "init", "--quiet");
    writeFileSync(join(repository, "README.md"), "test\n", "utf8");
    git(repository, "add", "README.md");
    git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "init");
    git(repository, "worktree", "add", "--quiet", worktree, "-b", "linked");
    const nested = join(worktree, "nested");
    mkdirSync(nested);

    expect(resolveWorkspaceContext(nested).worktree).toBe(realpathSync.native(worktree));
    expect(resolveWorkspaceContext(nested).worktree).not.toBe(realpathSync.native(repository));
  });

  test("canonicalizes symlinks and refuses a stored context after its Git boundary changes", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-workspace-symlink-"));
    const linkRoot = mkdtempSync(join(tmpdir(), "lxe-workspace-link-parent-"));
    roots.push(root, linkRoot);
    const nested = join(root, "nested");
    mkdirSync(nested);
    const link = join(linkRoot, "workspace-link");
    symlinkSync(nested, link, process.platform === "win32" ? "junction" : "dir");

    const resolved = resolveWorkspaceContext(link);
    expect(resolved.directory).toBe(realpathSync.native(nested));
    expect(sameWorkspaceContext(resolved, workspaceContextFrom(resolved))).toBe(true);
    expect(() => assertWorkspaceAvailable({ ...resolved, worktree: linkRoot })).toThrow("no longer matches");
  });

  test("fails explicitly when a session directory is deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-workspace-deleted-"));
    roots.push(root);
    const workspace = resolveWorkspaceContext(root);
    rmSync(root, { recursive: true, force: true });
    expect(() => assertWorkspaceAvailable(workspace)).toThrow();
  });
});
