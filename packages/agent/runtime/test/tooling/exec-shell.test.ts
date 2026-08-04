import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  DEFAULT_EXEC_YIELD_MS,
  DEFAULT_WAIT_YIELD_MS,
  ExecShellAdapter,
  MAX_EXEC_YIELD_MS,
  MAX_WAIT_YIELD_MS,
  MIN_EXEC_YIELD_MS,
  MIN_WAIT_YIELD_MS,
  resolveWindowsPowerShell,
} from "../../src/tooling/exec-shell";

describe("ExecShellAdapter", () => {
  for (const platform of ["darwin", "linux"] as const) {
    test(`uses /bin/sh and POSIX paths on ${platform}`, () => {
      const shell = new ExecShellAdapter({ platform, environment: { PATH: "/usr/bin:/bin" } });
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
        LXE_WORKSPACE_ROOT: "/workspace",
      });
    });
  }

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
    })).toEqual({ path: preferred, major: 7 });
  });

  test("falls back to built-in Windows PowerShell when pwsh is unavailable", () => {
    const fallback = win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    expect(resolveWindowsPowerShell({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      fileExists: (path) => path === fallback,
      which: () => null,
      powerShellMajor: () => undefined,
    })).toEqual({ path: fallback, major: 5 });
  });

  test("reports the shell profile the exec description has to document", () => {
    expect(new ExecShellAdapter({ platform: "darwin" }).shellProfile()).toEqual({ kind: "posix" });

    const pwsh = win32.join("C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    expect(new ExecShellAdapter({
      platform: "win32",
      environment: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
      fileExists: (path) => path === pwsh,
      which: () => null,
      powerShellMajor: () => 7,
    }).shellProfile()).toEqual({ kind: "pwsh", major: 7 });

    const builtin = win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    expect(new ExecShellAdapter({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      fileExists: (path) => path === builtin,
      which: () => null,
      powerShellMajor: () => undefined,
    }).shellProfile()).toEqual({ kind: "windows-powershell", major: 5 });

    // No PowerShell at all: registration must still succeed, and the stricter 5.1
    // rules are the safe thing to document because they also parse under 7.
    expect(new ExecShellAdapter({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      fileExists: () => false,
      which: () => null,
      powerShellMajor: () => undefined,
    }).shellProfile()).toEqual({ kind: "windows-powershell" });
  });

  test("normalizes Python, pip, and lxeskill with platform-safe quoting", () => {
    const posix = new ExecShellAdapter({
      platform: "darwin",
      fileExists: (path) => path.endsWith("/.venv/bin/python"),
    });
    expect(posix.normalizeCommand("/work/O'Brien", "python -c \"print(1)\"")).toBe(
      `'/work/O'"'"'Brien/.venv/bin/python' -c "print(1)"`,
    );
    expect(posix.normalizeCommand("/work/demo", "pip install demo")).toBe(
      "'/work/demo/.venv/bin/python' -m pip install demo",
    );
    expect(posix.normalizeCommand("/work/demo", "lxeskill fba purchase summary-create --input-json args.json")).toBe(
      "'/work/demo/.venv/bin/python' '-I' '-B' '-m' 'lxeskill' fba purchase summary-create --input-json args.json",
    );

    const windows = new ExecShellAdapter({
      platform: "win32",
      fileExists: (path) => path.endsWith(".venv\\Scripts\\python.exe"),
    });
    expect(windows.normalizeCommand("C:\\Work O'Brien", "python -c \"print(1)\"")).toBe(
      "& 'C:\\Work O''Brien\\.venv\\Scripts\\python.exe' -c \"print(1)\"",
    );
    expect(windows.normalizeCommand("C:\\Work O'Brien", "pip install demo")).toBe(
      "& 'C:\\Work O''Brien\\.venv\\Scripts\\python.exe' -m pip install demo",
    );
    expect(windows.normalizeCommand("C:\\Work O'Brien", "lxeskill list")).toBe(
      "& 'C:\\Work O''Brien\\.venv\\Scripts\\python.exe' '-I' '-B' '-m' 'lxeskill' list",
    );
  });

  test("puts the project venv ahead of a fake system lxeskill", () => {
    const shell = new ExecShellAdapter({
      platform: "darwin",
      environment: { PATH: "/fake/system/bin:/usr/bin" },
      fileExists: (path) => path.endsWith("/.venv/bin/python"),
    });
    expect(shell.normalizeCommand("/work/project", "lxeskill list")).toBe(
      "'/work/project/.venv/bin/python' '-I' '-B' '-m' 'lxeskill' list",
    );
    expect(shell.childEnvironment("/work/project", {
      sessionId: "s1",
      turnId: "t1",
      responseRouteId: "r1",
      execSessionId: "e1",
    }).PATH).toBe("/work/project/.venv/bin:/fake/system/bin:/usr/bin");
  });

  test("uses the explicit managed Python path without a generic resource root", () => {
    const resourcePython = "/resources/lxe/.venv/bin/python";
    const shell = new ExecShellAdapter({
      platform: "darwin",
      environment: { LXE_MANAGED_PYTHON: resourcePython },
      fileExists: (path) => path === resourcePython,
    });

    expect(shell.lxeSkillArgv("/Users/demo/Documents/LXE Agent")).toEqual([
      resourcePython,
      "-I",
      "-B",
      "-m",
      "lxeskill",
    ]);
    expect(shell.normalizeCommand(
      "/Users/demo/Documents/LXE Agent",
      "lxeskill list",
    )).toBe("'/resources/lxe/.venv/bin/python' '-I' '-B' '-m' 'lxeskill' list");
  });

  test("keeps desktop managed tools ahead of the user workspace", () => {
    const managedPython = "C:\\LXE\\python\\python.exe";
    const shell = new ExecShellAdapter({
      platform: "win32",
      environment: {
        PATH: "C:\\Windows\\System32",
        LXE_MANAGED_PATH: "C:\\LXE\\node;C:\\LXE\\python;C:\\LXE\\tools",
        LXE_MANAGED_PYTHON: managedPython,
      },
      fileExists: (path) => path === managedPython,
    });
    const environment = shell.childEnvironment("C:\\Users\\demo\\workspace", {
      sessionId: "s1",
      turnId: "t1",
      responseRouteId: "r1",
      execSessionId: "e1",
    });
    expect(environment.PATH).toBe(
      "C:\\LXE\\node;C:\\LXE\\python;C:\\LXE\\tools;C:\\Windows\\System32",
    );
    expect(environment.VIRTUAL_ENV).toBeUndefined();
    expect(environment.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(environment.PYTHONNOUSERSITE).toBe("1");
    expect(shell.normalizeCommand(
      "C:\\Users\\demo\\workspace",
      "uv run --frozen python scripts/report.py --format json",
    )).toBe("& 'C:\\LXE\\python\\python.exe' scripts/report.py --format json");
  });

  test("does not expose Bun-only SOUL, catalog, or LLM paths to Python commands", () => {
    const shell = new ExecShellAdapter({
      platform: "darwin",
      environment: {
        LXE_AGENT_SOUL_PATH: "/resources/agent/SOUL.md",
        LXE_SKILLS_ROOT: "/resources/skills",
        LXE_USER_SKILLS_ROOT: "/home/tester/.agents/skills",
        LXE_LXESKILL_CATALOG_PATH: "/resources/lxeskill/catalog.json",
        LXE_LLM_CONFIG_ROOT: "/resources/config/llm",
        LXE_PERMISSION_POLICY_PATH: "/resources/config/permission_policy.yaml",
        LXE_DATA_ROOT: "/state",
        LXE_ROOT: "/legacy",
        LXE_RESOURCE_ROOT: "/legacy/resources",
      },
    });
    const environment = shell.childEnvironment("/workspace", {
      sessionId: "s1", turnId: "t1", responseRouteId: "r1", execSessionId: "e1",
    });

    expect(environment.LXE_AGENT_SOUL_PATH).toBeUndefined();
    expect(environment.LXE_USER_SKILLS_ROOT).toBeUndefined();
    expect(environment.LXE_LXESKILL_CATALOG_PATH).toBeUndefined();
    expect(environment.LXE_LLM_CONFIG_ROOT).toBeUndefined();
    expect(environment.LXE_ROOT).toBeUndefined();
    expect(environment.LXE_RESOURCE_ROOT).toBeUndefined();
    expect(environment.LXE_SKILLS_ROOT).toBe("/resources/skills");
    expect(environment.LXE_PERMISSION_POLICY_PATH).toBe("/resources/config/permission_policy.yaml");
    expect(environment.LXE_DATA_ROOT).toBe("/state");
    expect(environment.LXE_WORKSPACE_ROOT).toBe("/workspace");
  });

  test("passes resolved Data Server settings to summary-create lxeskill children", () => {
    const managedPython = "/managed/python/bin/python";
    const shell = new ExecShellAdapter({
      platform: "darwin",
      environment: {
        LXE_MANAGED_PYTHON: managedPython,
        LXE_DATA_SERVER_URL: "http://127.0.0.1:18000",
        LXE_ERP_API_KEY: "erp-test-secret",
      },
      fileExists: (path) => path === managedPython,
    });

    const environment = shell.childEnvironment("/workspace", {
      sessionId: "s1", turnId: "t1", responseRouteId: "r1", execSessionId: "e1",
    });
    expect(environment.LXE_DATA_SERVER_URL).toBe("http://127.0.0.1:18000");
    expect(environment.LXE_ERP_API_KEY).toBe("erp-test-secret");
    expect(shell.normalizeCommand(
      "/workspace",
      "lxeskill fba purchase summary-create --help",
    )).toBe(
      "'/managed/python/bin/python' '-I' '-B' '-m' 'lxeskill' fba purchase summary-create --help",
    );
  });

  test("uses managed Python and ignores removed frozen-runtime overrides", () => {
    const frozen = "/work/project/packages/agent/lxeskill-cli/vendor/darwin-arm64/lxeskill/lxeskill";
    const managedPython = "/managed/python/bin/python";
    const shell = new ExecShellAdapter({
      platform: "darwin",
      environment: {
        PATH: "/usr/bin",
        LXE_MANAGED_PYTHON: managedPython,
        LXESKILL_BINARY_PATH: frozen,
        LXESKILL_REQUIRE_BUNDLE: "1",
      },
      fileExists: (path) => path === frozen || path === managedPython,
    });

    expect(shell.lxeSkillArgv("/work/project")).toEqual([
      managedPython,
      "-I",
      "-B",
      "-m",
      "lxeskill",
    ]);
    expect(shell.normalizeCommand("/work/project", "lxeskill list")).toBe(
      `'/managed/python/bin/python' '-I' '-B' '-m' 'lxeskill' list`,
    );
  });

  test("rejects direct business modules and unsupported Python launcher versions", () => {
    const shell = new ExecShellAdapter({ platform: "darwin", fileExists: () => true });
    expect(() => shell.normalizeCommand("/work", "python -m services.agent_cli.demo"))
      .toThrow("through lxeskill");
    expect(() => shell.normalizeCommand("/work", "py -3.11 script.py"))
      .toThrow("Python 3.12.10");
  });

  test("freezes exec timing defaults", () => {
    expect(DEFAULT_EXEC_YIELD_MS).toBe(10_000);
    expect(MIN_EXEC_YIELD_MS).toBe(250);
    expect(MAX_EXEC_YIELD_MS).toBe(30_000);
    expect(DEFAULT_WAIT_YIELD_MS).toBe(10_000);
    expect(MIN_WAIT_YIELD_MS).toBe(5_000);
    expect(MAX_WAIT_YIELD_MS).toBe(300_000);
  });
});
