import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("wt-claim shell entrypoint", () => {
  test("keeps the extensionless Bash script on LF checkouts", () => {
    const attributes = readFileSync(resolve(repositoryRoot, ".gitattributes"), "utf8");
    const script = readFileSync(resolve(repositoryRoot, "scripts", "wt-claim"), "utf8");

    expect(attributes).toContain("scripts/wt-claim text eol=lf");
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).not.toContain("\r");
    expect(script).toContain("set -euo pipefail\n");
  });

  test("provides a native Windows PowerShell entrypoint", () => {
    const script = readFileSync(resolve(repositoryRoot, "scripts", "wt-claim.ps1"), "utf8");

    expect(script).toContain('if ($Command -eq "status")');
    expect(script).toContain('if ($Command -eq "release")');
    expect(script).toContain('"codex/$slug"');
    expect(script).toContain("bun install --frozen-lockfile");
    expect(script).toContain("uv sync --frozen");
  });
});

// Exercise the native entrypoint on each host using disposable Git repositories.
// Only dependency installation is stubbed; refs, commits and worktrees are real.
const windows = process.platform === "win32";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "lxe wt-claim-"));
  temporaryRoots.push(temporary);
  const root = join(temporary, "repository");
  const bin = join(temporary, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  for (const command of ["bun", "uv"]) {
    writeFileSync(join(bin, command + (windows ? ".cmd" : "")), windows
      ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Worktree Test");
  git(root, "config", "user.email", "worktree-test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, ".gitignore"), ".worktrees/\n.venv/\n");
  writeFileSync(join(root, "content.txt"), "main\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  const slot = join(root, ".worktrees", "pool-1");
  git(root, "worktree", "add", "-b", "codex/review", slot, "main");
  writeFileSync(`${slot}.claim`, "review\n");
  writeFileSync(join(slot, "content.txt"), "review changes\n");
  git(slot, "add", "content.txt");
  git(slot, "commit", "-m", "review changes");
  mkdirSync(join(slot, ".venv"));
  writeFileSync(join(slot, ".venv", "sentinel"), "checkout dependency\n");
  const commit = git(slot, "rev-parse", "HEAD");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const env = { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}`, WT_POOL_MAX: "1" };
  const run = (...args: string[]) => spawnSync(windows ? "powershell.exe" : "bash", windows
    ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repositoryRoot, "scripts/wt-claim.ps1"), ...args]
    : [join(repositoryRoot, "scripts/wt-claim"), ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  return { temporary, root, slot, commit, run };
}

function expectSuccess(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  if (result.status !== 0) throw new Error(`${result.error ?? result.stderr}\n${result.stdout}`);
}

describe(`wt-claim lifecycle (${windows ? "PowerShell" : "Bash"})`, () => {
  test.each(["local-only", "pushed", "merged"] as const)("release preserves a %s branch", (state) => {
    const f = fixture();
    if (state === "pushed") {
      const remote = join(f.temporary, "remote.git");
      git(f.root, "init", "--bare", remote);
      git(f.root, "remote", "add", "origin", remote);
      git(f.slot, "push", "-u", "origin", "codex/review");
    } else if (state === "merged") {
      git(f.root, "merge", "--ff-only", "codex/review");
    }
    const mainBefore = git(f.root, "rev-parse", "main");
    const result = f.run("release", "review");
    expectSuccess(result);
    expect(result.stdout).toContain("kept branch codex/review");
    expect(existsSync(`${f.slot}.claim`)).toBe(false);
    expect(git(f.slot, "branch", "--show-current")).toBe("");
    expect(git(f.root, "rev-parse", "codex/review")).toBe(f.commit);
    expect(git(f.root, "rev-parse", "main")).toBe(mainBefore);
    expect(readFileSync(join(f.slot, ".venv", "sentinel"), "utf8")).toBe("checkout dependency\n");
    if (state === "pushed") {
      expect(git(f.root, "ls-remote", "origin", "refs/heads/codex/review")).toContain(f.commit);
    }
    const status = f.run("status");
    expectSuccess(status);
    expect(status.stdout).toContain("pool-1  detached  idle");
  }, 30_000);

  test("reuses the only slot for another task, then resumes the retained branch", () => {
    const f = fixture();
    expectSuccess(f.run("release", "review"));
    expectSuccess(f.run("other"));
    expect(git(f.slot, "branch", "--show-current")).toBe("codex/other");
    expect(git(f.root, "rev-parse", "codex/review")).toBe(f.commit);
    expectSuccess(f.run("release", "other"));
    const resumed = f.run("review");
    expectSuccess(resumed);
    expect(resumed.stdout).toContain("reattached pool-1");
    expect(git(f.slot, "branch", "--show-current")).toBe("codex/review");
    expect(git(f.slot, "rev-parse", "HEAD")).toBe(f.commit);
    expect(readFileSync(`${f.slot}.claim`, "utf8").trim()).toBe("review");
    expect(readFileSync(join(f.slot, "content.txt"), "utf8")).toBe("review changes\n");
  }, 30_000);

  test.each(["content.txt", "untracked.txt"])("rejects release with uncommitted %s", (file) => {
    const f = fixture();
    writeFileSync(join(f.slot, file), "unfinished work\n");
    const result = f.run("release", "review");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uncommitted changes");
    expect(readFileSync(`${f.slot}.claim`, "utf8").trim()).toBe("review");
    expect(git(f.slot, "branch", "--show-current")).toBe("codex/review");
    expect(git(f.slot, "rev-parse", "HEAD")).toBe(f.commit);
    expect(readFileSync(join(f.slot, file), "utf8")).toBe("unfinished work\n");
  }, 30_000);
});
