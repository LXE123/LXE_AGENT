import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopLxeSkillHealth } from "../src/main/lxeskill-health";

const roots: string[] = [];
const services: DesktopLxeSkillHealth[] = [];
const success = () => ({ stdout: JSON.stringify({ protocol_version: "1", type: "result", command: "list", ok: true, data: { commands: [] }, files: [] }), stderr: "", error: null });
type Options = ConstructorParameters<typeof DesktopLxeSkillHealth>[0];
const serviceFor = (overrides: Partial<Options> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "lxe-desktop-cli-health-")); roots.push(root);
  const service = new DesktopLxeSkillHealth({
    executablePath: join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/lxeskill.exe" : "bin/lxeskill"),
    dataRoot: root, recovery: "repair CLI",
    environment: { ...process.env, LOCAL_LOGS_ENABLED: "0", LXE_DATA_ROOT: root, LXE_SQLITE_DB_PATH: join(root, "lxeskill.sqlite3") },
    ...overrides,
  });
  services.push(service); return service;
};
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop lxeskill health", () => {
  test("runs the public list command through the executable, without Agent DB or private resource paths", async () => {
    const states: string[] = [];
    let calls = 0;
    const service = serviceFor({
      environment: { LXE_AGENT_SQLITE_DB_PATH: "/private/agent.sqlite3", LXE_USER_SKILLS_ROOT: "/private/skills", LXE_SQLITE_DB_PATH: "/business.sqlite3" },
      execute: async (file, args, options) => {
        calls++;
        expect(file).toContain("lxeskill");
        expect(args).toEqual(["list"]);
        expect(options.timeout).toBe(30_000);
        expect(options.env).toEqual({ LXE_SQLITE_DB_PATH: "/business.sqlite3" });
        return success();
      },
      onChanged: () => states.push(service.snapshot().state),
    });
    expect(service.snapshot().state).toBe("stopped");
    const pending = service.check();
    expect(service.check()).toBe(pending);
    expect(service.snapshot().state).toBe("starting");
    await pending;
    expect(calls).toBe(1);
    expect(states).toEqual(["starting", "ready"]);
    expect(service.snapshot()).toEqual({ state: "ready", message: "" });
  });

  test("reports actual CLI failures and can recheck successfully after repair", async () => {
    let repaired = false;
    const service = serviceFor({ execute: async () => repaired ? success() : {
      stdout: JSON.stringify({ protocol_version: "1", type: "result", command: "list", ok: false, data: {}, files: [], error: { code: "bad_catalog", message: "fixture missing command_path" } }),
      stderr: "fixture validation traceback", error: new Error("exit 2"),
    } });
    await expect(service.check()).resolves.toBeUndefined();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain("fixture missing command_path");
    expect(service.snapshot().message).toContain("fixture validation traceback");
    repaired = true;
    await service.check();
    expect(service.snapshot()).toEqual({ state: "ready", message: "" });
  });

  test.each(["", "not json", "null", `${success().stdout}\n${success().stdout}`,
    success().stdout.replace('"1"', '"2"'), success().stdout.replace('"list"', '"doctor"'),
    success().stdout.replace('"commands":[]', '"commands":null')])("rejects invalid or inconsistent list output: %s", async stdout => {
    const service = serviceFor({ execute: async () => ({ stdout, stderr: "fixture diagnostic", error: null }) });
    await service.check();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain("fixture diagnostic");
  });

  test("does not report ready after a nonzero exit even if stdout claims success", async () => {
    const service = serviceFor({ execute: async () => ({ ...success(), error: new Error("exit 3") }) });
    await service.check();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain("exit 3");
  });

  test("cancels a pending probe and ignores its stale completion after a new check", async () => {
    let finish!: (result: ReturnType<typeof success>) => void;
    let signal: AbortSignal | undefined;
    let calls = 0;
    const service = serviceFor({ execute: async (_file, _args, options) => {
      if (++calls > 1) return success();
      signal = options.signal;
      return await new Promise(resolve => { finish = resolve; });
    } });
    const first = service.check();
    await Promise.resolve();
    const stopping = service.stop();
    expect(signal?.aborted).toBe(true);
    expect(service.snapshot().state).toBe("stopped");
    await service.check();
    finish({ ...success(), stdout: "stale broken output" });
    await Promise.all([first, stopping]);
    expect(service.snapshot()).toEqual({ state: "ready", message: "" });
  });

  test("redacts configured secrets and explicitly truncates actual diagnostics", async () => {
    const service = serviceFor({ environment: { API_TOKEN: "fixture-sensitive-token" }, execute: async () => ({
      stdout: "", stderr: "x".repeat(5000) + " actual refusal fixture-sensitive-token", error: new Error("exit 1"),
    }) });
    await service.check();
    expect(service.snapshot().message).toContain("[truncated]");
    expect(service.snapshot().message).toContain("actual refusal [redacted]");
    expect(service.snapshot().message).not.toContain("fixture-sensitive-token");
  });

  test("probes the real installed CLI using Node child_process", async () => {
    const service = serviceFor();
    await service.check();
    expect(service.snapshot()).toEqual({ state: "ready", message: "" });
  });

  test("reports the actual spawn failure for an absent Python", async () => {
    const executablePath = join(tmpdir(), "absent-lxe-health-python");
    const service = serviceFor({ executablePath, environment: {} });
    await service.check();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain(executablePath);
    expect(service.snapshot().message).toMatch(/ENOENT|Executable not found in \$PATH/u);
  });

  test("terminates a hung subprocess at the probe deadline", async () => {
    let killed = false;
    const service = serviceFor({ timeoutMs: 50, execute: (_file, _args, options) => new Promise(resolve => {
      execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, (error, stdout, stderr) => {
        killed = error?.killed === true;
        resolve({ error, stdout: String(stdout), stderr: String(stderr) });
      });
    }) });
    await service.check();
    expect(killed).toBe(true);
    expect(service.snapshot().state).toBe("error");
  });
});
