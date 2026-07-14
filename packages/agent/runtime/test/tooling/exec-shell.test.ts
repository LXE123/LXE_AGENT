import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  DEFAULT_EXEC_TIMEOUT_SECONDS,
  DEFAULT_EXEC_YIELD_MS,
  ExecShellAdapter,
  MAX_EXEC_TIMEOUT_SECONDS,
  resolveWindowsPowerShell,
} from "../../src/tooling/exec-shell";

describe("ExecShellAdapter", () => {
  test("uses /bin/sh without a login profile on Unix", () => {
    const shell = new ExecShellAdapter({ platform: "darwin", environment: { PATH: "/usr/bin:/bin" } });
    expect(shell.spawnSpec("printf ok")).toEqual({
      argv: ["/bin/sh", "-c", "printf ok"],
      detached: true,
    });
    expect(shell.childEnvironment("/workspace", {
      sessionId: "session", turnId: "turn", responseRouteId: "route", execSessionId: "exec",
    })).toMatchObject({
      PATH: "/workspace/.venv/bin:/usr/bin:/bin",
      VIRTUAL_ENV: "/workspace/.venv",
      LXE_AGENT_SESSION_ID: "session",
      LXE_AGENT_TURN_ID: "turn",
      LXE_RESPONSE_ROUTE_ID: "route",
      LXE_EXEC_SESSION_ID: "exec",
    });
  });

  test("resolves verified PowerShell 7 before Windows PowerShell 5.1", () => {
    const programFiles = "C:\\Program Files";
    const programW6432 = "D:\\Program Files";
    const preferred = win32.join(programW6432, "PowerShell", "7", "pwsh.exe");
    const fallback = win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const pathPwsh = "E:\\Tools\\pwsh.exe";
    const existing = new Set([preferred, fallback]);
    expect(resolveWindowsPowerShell({
      platform: "win32",
      environment: { ProgramFiles: programFiles, ProgramW6432: programW6432, SystemRoot: "C:\\Windows" },
      fileExists: (path) => existing.has(path),
      which: (command) => command === "pwsh" ? pathPwsh : null,
      powerShellMajor: (path) => path === preferred ? 7 : 6,
    })).toBe(preferred);
  });

  test("falls back to built-in Windows PowerShell when pwsh is unavailable", () => {
    const fallback = win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    expect(resolveWindowsPowerShell({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      fileExists: (path) => path === fallback,
      which: () => null,
      powerShellMajor: () => undefined,
    })).toBe(fallback);
  });

  test("normalizes Python, pip, and lxeskill with platform-safe quoting", () => {
    const posix = new ExecShellAdapter({ platform: "darwin", fileExists: () => true });
    expect(posix.normalizeCommand("/work/O'Brien", "python -c \"print(1)\"")).toBe(
      `'/work/O'"'"'Brien/.venv/bin/python' -c "print(1)"`,
    );
    expect(posix.normalizeCommand("/work/demo", "pip install demo")).toBe(
      "'/work/demo/.venv/bin/python' -m pip install demo",
    );
    expect(posix.normalizeCommand("/work/demo", "lxeskill fba purchase contracts-fill --input-json args.json")).toBe(
      "'/work/demo/.venv/bin/python' -m lxeskill fba purchase contracts-fill --input-json args.json",
    );

    const windows = new ExecShellAdapter({ platform: "win32", fileExists: () => true });
    expect(windows.normalizeCommand("C:\\Work O'Brien", "lxeskill list")).toBe(
      "'C:\\Work O''Brien\\.venv\\Scripts\\python.exe' -m lxeskill list",
    );
  });

  test("puts the project venv ahead of a fake system lxeskill", () => {
    const shell = new ExecShellAdapter({
      platform: "darwin",
      environment: { PATH: "/fake/system/bin:/usr/bin" },
      fileExists: () => true,
    });
    expect(shell.normalizeCommand("/work/project", "lxeskill list")).toBe(
      "'/work/project/.venv/bin/python' -m lxeskill list",
    );
    expect(shell.childEnvironment("/work/project", {
      sessionId: "s1",
      turnId: "t1",
      responseRouteId: "r1",
      execSessionId: "e1",
    }).PATH).toBe("/work/project/.venv/bin:/fake/system/bin:/usr/bin");
  });

  test("rejects direct business modules and unsupported Python launcher versions", () => {
    const shell = new ExecShellAdapter({ platform: "darwin", fileExists: () => true });
    expect(() => shell.normalizeCommand("/work", "python -m services.agent_cli.demo"))
      .toThrow("through lxeskill");
    expect(() => shell.normalizeCommand("/work", "py -3.11 script.py"))
      .toThrow("Python 3.12.10");
  });

  test("freezes exec timing defaults", () => {
    expect(DEFAULT_EXEC_TIMEOUT_SECONDS).toBe(120);
    expect(MAX_EXEC_TIMEOUT_SECONDS).toBe(3_600);
    expect(DEFAULT_EXEC_YIELD_MS).toBe(10_000);
  });
});
