import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "lxe wt-claim-")));
  temporaryRoots.push(temporary);
  const root = join(temporary, "repository");
  const bin = join(temporary, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  const install = join(bin, "install.cjs");
  writeFileSync(install, `const fs = require("node:fs");
if (process.env.LXE_TEST_WT_FAIL) process.exit(7);
const gate = process.env.LXE_TEST_WT_GATE;
if (gate) {
  fs.writeFileSync(gate + ".ready", "ready");
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(gate + ".continue")) {
    if (Date.now() > deadline) throw Error("Test installation gate timed out");
    await Bun.sleep(25);
  }
}
`);
  for (const command of ["bun", "uv"]) {
    writeFileSync(join(bin, command + (windows ? ".cmd" : "")), windows
      ? command === "bun" ? `@echo off\r\nif "%~1"=="install" goto install\r\n"${process.execPath}" %*\r\nexit /b %errorlevel%\r\n:install\r\n"${process.execPath}" "${install}"\r\nexit /b %errorlevel%\r\n` : "@echo off\r\nexit /b 0\r\n"
      : command === "bun" ? `#!/bin/sh\nif [ "$1" = install ]; then exec '${process.execPath.replaceAll("'", "'\\''")}' '${install.replaceAll("'", "'\\''")}'; fi\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n` : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Worktree Test");
  git(root, "config", "user.email", "worktree-test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, ".gitignore"), ".worktrees/\n.venv/\nvar/\n.env\n");
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
  const env: NodeJS.ProcessEnv = { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}`, WT_POOL_MAX: "1" };
  const command = (...args: string[]) => [windows ? "powershell.exe" : "bash", ...(windows
    ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repositoryRoot, "scripts/wt-claim.ps1"), ...args]
    : [join(repositoryRoot, "scripts/wt-claim"), ...args])];
  const run = (...args: string[]) => {
    const [executable, ...argv] = command(...args);
    return spawnSync(executable!, argv, { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  };
  const start = (...args: string[]) => {
    const child = Bun.spawn(command(...args), { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const completed = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      .then(([status, stdout, stderr]) => ({ status, stdout, stderr }));
    return { child, completed };
  };
  return { temporary, root, slot, commit, env, run, start };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await Bun.sleep(25);
  }
}

function expectSuccess(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  if (result.status !== 0) throw new Error(`${result.error ?? result.stderr}\n${result.stdout}`);
}

describe(`wt-claim lifecycle (${windows ? "PowerShell" : "Bash"})`, () => {
  test("simultaneous claims cannot take the same slot", async () => {
    const f = fixture();
    expectSuccess(f.run("release", "review"));
    f.env.WT_POOL_MAX = "2";
    const gate = join(f.temporary, "install-gate");
    f.env.LXE_TEST_WT_GATE = gate;
    const first = f.start("alpha"), second = f.start("beta");
    try {
      await waitForFile(`${gate}.ready`);
      const rejected = await Promise.race([first.completed, second.completed]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("cannot acquire pool lock");
      const owner = readFileSync(`${f.slot}.claim`, "utf8").trim();
      expect(["alpha", "beta"]).toContain(owner);
      expect(git(f.slot, "branch", "--show-current")).toBe(`codex/${owner}`);
      expect(existsSync(join(f.root, ".worktrees/pool-2"))).toBe(false);
      writeFileSync(`${gate}.continue`, "continue");
      const results = await Promise.all([first.completed, second.completed]);
      expect(results.map(result => result.status).sort()).toEqual([0, 1]);
      expect(existsSync(join(f.root, ".worktrees/.wt-claim.lock"))).toBe(false);
      expectSuccess(f.run(owner === "alpha" ? "beta" : "alpha"));
      expect(readFileSync(join(f.root, ".worktrees/pool-2.claim"), "utf8").trim()).not.toBe(owner);
    } finally {
      writeFileSync(`${gate}.continue`, "continue");
      await Promise.all([first.completed, second.completed]);
    }
  }, 40_000);

  test("busy preparation blocks release and refresh while status remains available", async () => {
    const f = fixture();
    const gate = join(f.temporary, "install-gate");
    f.env.LXE_TEST_WT_GATE = gate;
    const preparing = f.start("review");
    try {
      await waitForFile(`${gate}.ready`);
      for (const args of [["review"], ["release", "review"], ["refresh-config", "review"]]) {
        const rejected = f.run(...args);
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain("cannot acquire pool lock");
        expect(existsSync(join(f.root, ".worktrees/.wt-claim.lock"))).toBe(true);
      }
      expectSuccess(f.run("status"));
      expect(git(f.slot, "branch", "--show-current")).toBe("codex/review");
      expect(readFileSync(`${f.slot}.claim`, "utf8").trim()).toBe("review");
    } finally {
      writeFileSync(`${gate}.continue`, "continue");
      const result = await preparing.completed;
      expect(result.status).toBe(0);
    }
    expect(existsSync(join(f.root, ".worktrees/.wt-claim.lock"))).toBe(false);
    expectSuccess(f.run("release", "review"));
  }, 40_000);

  test("installation failure releases the lock so the same task can retry", () => {
    const f = fixture();
    f.env.LXE_TEST_WT_FAIL = "1";
    expect(f.run("review").status).not.toBe(0);
    expect(existsSync(join(f.root, ".worktrees/.wt-claim.lock"))).toBe(false);
    expect(readFileSync(`${f.slot}.claim`, "utf8").trim()).toBe("review");
    delete f.env.LXE_TEST_WT_FAIL;
    expectSuccess(f.run("review"));
  }, 30_000);

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

  test("resuming retains local config and refresh-config requires an owned slot", () => {
    const f = fixture();
    writeFileSync(join(f.root, ".env"), "FIXTURE=main\n");
    writeFileSync(join(f.slot, ".env"), "FIXTURE=worktree\n");
    const resumed = f.run("review");
    expectSuccess(resumed);
    expect(resumed.stdout).toContain("existing configuration retained");
    expect(resumed.stdout.trim().split(/\r?\n/).at(-1)).toBe(f.slot);
    expect(readFileSync(join(f.slot, ".env"), "utf8")).toBe("FIXTURE=worktree\n");
    const unknown = f.run("refresh-config", "another-task");
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("no slot claimed");
  }, 30_000);

  test.skipIf(process.env.LXE_TEST_CREDENTIALS !== "1")("native entrypoint initializes config and explicitly refreshes it", () => {
    const f = fixture();
    const packagePath = join(repositoryRoot, "apps/desktop/package.json");
    const electron = createRequire(packagePath)("electron") as string;
    mkdirSync(join(f.slot, "apps/desktop/node_modules/electron"), { recursive: true });
    writeFileSync(join(f.slot, "apps/desktop/package.json"), JSON.stringify({ name: JSON.parse(readFileSync(packagePath, "utf8")).name }));
    writeFileSync(join(f.slot, "apps/desktop/node_modules/electron/index.js"), `module.exports = ${JSON.stringify(electron)};`);
    writeFileSync(join(f.root, ".env"), "FIXTURE=first\n");
    const initialized = f.run("review");
    expectSuccess(initialized);
    expect(initialized.stdout).toContain("test configuration initialized (1 files)");
    expect(readFileSync(join(f.slot, ".env"), "utf8")).toBe("FIXTURE=first\n");
    writeFileSync(join(f.root, ".env"), "FIXTURE=second\n");
    const refreshed = f.run("refresh-config", "review");
    expectSuccess(refreshed);
    expect(refreshed.stdout).toContain("test configuration refreshed");
    expect(refreshed.stdout).toContain("previous configuration:");
    expect(readFileSync(join(f.slot, ".env"), "utf8")).toBe("FIXTURE=second\n");
  }, 120_000);
});
