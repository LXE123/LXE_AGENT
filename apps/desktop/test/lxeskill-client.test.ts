import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { LxeSkillClient, LxeSkillError, settingsPayload } from "../src/main/lxeskill-client";
import { fixtureClient, removeFixtures, sourceLxeSkillPath } from "./support/lxeskill-fixture";

afterEach(removeFixtures);

const failure = async (promise: Promise<unknown>): Promise<LxeSkillError> => {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(LxeSkillError);
    return error as LxeSkillError;
  }
  throw new Error("expected the lxeskill call to fail");
};

describe("lxeskill client environment", () => {
  test("inherits the app environment without credentials, Agent-only or foreign Python settings", () => {
    const client = new LxeSkillClient({
      executablePath: "/unused", dataRoot: "/data", managedPath: "/managed", skillsRoot: "/skills",
      environment: () => ({
        PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.invalid", SystemRoot: "C:\\Windows",
        LXE_YACANG_PASSWORD: "fixture", MABANG_COOKIE: "fixture", LXE_DATA_SERVER_API_KEY: "fixture", GH_TOKEN: "fixture",
        LXE_AGENT_SESSION_ID: "turn", LXE_AGENT_SQLITE_DB_PATH: "/agent.sqlite3", LXESKILL_SKILL_SCOPE: "skill",
        LXE_USER_SKILLS_ROOT: "/user-skills", LXE_SQLITE_DB_PATH: "/elsewhere.sqlite3", PYTHONPATH: "/other-checkout",
        LXE_DATA_ROOT: "/inherited-data",
      }),
    });
    const environment = client.environment({ LXE_EXIFTOOL_PATH: "/tools/exiftool" });
    expect(environment).toEqual({
      PATH: ["/managed", "/usr/bin"].join(delimiter), HTTPS_PROXY: "http://proxy.invalid", SystemRoot: "C:\\Windows",
      LXE_DATA_ROOT: "/data", LXE_WORKSPACE_ROOT: join("/data", "workspace"), LXE_MANAGED_PATH: "/managed",
      LXE_SKILLS_ROOT: "/skills", TMP: join("/data", "tmp"), TEMP: join("/data", "tmp"), TMPDIR: join("/data", "tmp"),
      LXE_EXIFTOOL_PATH: "/tools/exiftool",
      PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1",
    });
  });

  test("keeps the Windows spelling of Path instead of adding a second PATH", () => {
    const client = new LxeSkillClient({
      executablePath: "/unused", dataRoot: "/data", managedPath: "/managed", environment: () => ({ Path: "C:\\tools" }),
    });
    const environment = client.environment();
    expect(environment.Path).toBe(["/managed", "C:\\tools"].join(delimiter));
    expect(environment).not.toHaveProperty("PATH");
  });
});

describe("lxeskill client protocol", () => {
  test("streams progress, passes stdin and returns the final result", async () => {
    const { client, dataRoot } = fixtureClient(`
let input = ""; for await (const chunk of process.stdin) input += chunk;
emit({ type: "progress", stage: "scan", processed: 1 });
emit({ type: "result", command: args.join(" "), ok: true, data: { input: JSON.parse(input), cwd: process.cwd(), tmp: process.env.TMPDIR }, files: ["a.xlsx"] });
`);
    const progress: unknown[] = [];
    const result = await client.run(["media", "scan"], { timeoutMs: 5_000, stdin: '{"n":1}', onProgress: record => progress.push(record) });
    expect(progress).toEqual([{ protocol_version: "1", type: "progress", stage: "scan", processed: 1 }]);
    expect(result.command).toBe("media scan");
    expect(result.files).toEqual(["a.xlsx"]);
    expect(result.data).toMatchObject({ input: { n: 1 }, tmp: join(dataRoot, "tmp") });
    expect(String(result.data.cwd)).toEndWith("data");
  });

  test("reports the structured error and stderr rather than the exit status", async () => {
    const { client } = fixtureClient(`
emit({ type: "result", command: "x", ok: false, data: {}, files: [], error: { code: "business_failed", message: "SKU A 缺少成本" } });
process.stderr.write("fixture traceback\\n"); process.exitCode = 4;
`);
    const error = await failure(client.run(["x"], { timeoutMs: 5_000 }));
    expect(error.message).toBe("SKU A 缺少成本\nfixture traceback");
  });

  test("treats data.success false as a failure and reports its message", async () => {
    const { client } = fixtureClient(`emit({ type: "result", command: "x", ok: true, data: { success: false, error: { message: "模板缺少工作表" } }, files: [] });`);
    expect((await failure(client.run(["x"], { timeoutMs: 5_000 }))).message).toBe("模板缺少工作表");
  });

  test("does not accept a successful-looking result from a failed process", async () => {
    const { client } = fixtureClient(`emit({ type: "result", command: "x", ok: true, data: {}, files: [] }); process.exitCode = 3;`);
    expect((await failure(client.run(["x"], { timeoutMs: 5_000 }))).message).toContain("lxeskill exited with code 3");
  });

  test("reports stderr and exit status when the command wrote no result", async () => {
    const { client } = fixtureClient(`process.stderr.write("ModuleNotFoundError: lxeskill\\n"); process.exitCode = 1;`);
    const message = (await failure(client.run(["x"], { timeoutMs: 5_000 }))).message;
    expect(message).toContain("lxeskill exited with code 1");
    expect(message).toContain("ModuleNotFoundError: lxeskill");
  });

  test.each([
    ["not json", "console.log('not json');", "Invalid lxeskill output line: not json"],
    ["wrong version", "console.log(JSON.stringify({ protocol_version: '2', type: 'result', ok: true, data: {} }));", "Invalid lxeskill output line"],
    ["two results", `emit({ type: "result", ok: true, data: {} }); emit({ type: "result", ok: true, data: {} });`, "output after its final result"],
    ["progress after result", `emit({ type: "result", ok: true, data: {} }); emit({ type: "progress" });`, "output after its final result"],
    ["no output", "", "lxeskill produced no result"],
  ])("rejects invalid output: %s", async (_name, script, expected) => {
    const { client } = fixtureClient(script);
    expect((await failure(client.run(["x"], { timeoutMs: 5_000 }))).message).toContain(expected);
  });

  test("stops a command whose output exceeds the limit", async () => {
    const { client } = fixtureClient(`for (let i = 0; i < 100; i++) emit({ type: "progress", padding: "x".repeat(100) }); setInterval(() => {}, 1_000);`);
    expect((await failure(client.run(["x"], { timeoutMs: 5_000, maxOutputBytes: 1_000 }))).message).toContain("output exceeds 1000 bytes");
  });

  test("redacts inherited credential values and marks truncated diagnostics", async () => {
    const { client } = fixtureClient(`process.stderr.write("x".repeat(5000) + " refused fixture-sensitive-token\\n"); process.exitCode = 1;`,
      { environment: () => ({ ...process.env, API_TOKEN: "fixture-sensitive-token" }) });
    const message = (await failure(client.run(["x"], { timeoutMs: 5_000 }))).message;
    expect(message).toStartWith("lxeskill exited with code 1\n[truncated] ");
    expect(message).toContain("refused [redacted]");
    expect(message).not.toContain("fixture-sensitive-token");
  });

  test("terminates a hung command at its deadline", async () => {
    const { client } = fixtureClient("setInterval(() => {}, 1_000);");
    const started = Date.now();
    expect((await failure(client.run(["x"], { timeoutMs: 100 }))).message).toContain("lxeskill timed out after 100ms");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("cancels a running command through its signal", async () => {
    const { client } = fixtureClient("setInterval(() => {}, 1_000);");
    const controller = new AbortController();
    const pending = client.run(["x"], { timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const error = await failure(pending);
    expect(error.cancelled).toBe(true);
  });

  test("enforces the output limit before a newline arrives", async () => {
    const { client } = fixtureClient(`process.stdout.write("x".repeat(8 * 1024)); setInterval(() => {}, 1_000);`);
    const started = Date.now();
    expect((await failure(client.run(["x"], { timeoutMs: 10_000, maxOutputBytes: 1_024 }))).message).toContain("output exceeds 1024 bytes");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  const helperFixture = (body: string) => {
    const fixture = fixtureClient("");
    const pidPath = join(fixture.root, "helper.pid");
    writeFileSync(join(fixture.root, "lxeskill-fixture.mjs"), `
const { spawn } = await import("node:child_process");
const { writeFileSync } = await import("node:fs");
const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5_000)"], { stdio: ["ignore", "inherit", "inherit"] });
writeFileSync(${JSON.stringify(pidPath)}, String(helper.pid));
${body}
`, "utf8");
    const alive = () => {
      try { process.kill(Number(readFileSync(pidPath, "utf8")), 0); return true; } catch { return false; }
    };
    const waitUntilGone = async () => {
      const deadline = Date.now() + 3_000;
      while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      return !alive();
    };
    return { client: fixture.client, pidPath, waitUntilGone };
  };

  test("does not wait for a helper that outlives the command", async () => {
    const { client, waitUntilGone } = helperFixture("helper.unref();");
    const started = Date.now();
    const message = (await failure(client.run(["x"], { timeoutMs: 400 }))).message;
    expect(Date.now() - started).toBeLessThan(2_500);
    if (process.platform === "win32") {
      // Windows closes the command's pipes when it exits, even though the helper inherited them.
      expect(message).toContain("lxeskill produced no result");
    } else {
      // The helper holds the pipes open; the deadline stops its process group and closes them.
      expect(message).toContain("lxeskill timed out after 400ms");
      expect(await waitUntilGone()).toBe(true);
    }
  });

  test("cancellation also ends tools the running command started", async () => {
    const { client, pidPath, waitUntilGone } = helperFixture("setInterval(() => {}, 1_000);");
    const controller = new AbortController();
    const pending = client.run(["x"], { timeoutMs: 10_000, signal: controller.signal });
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    expect((await failure(pending)).cancelled).toBe(true);
    expect(await waitUntilGone()).toBe(true);
  });

  test("keeps the business error when stderr is long", async () => {
    const { client } = fixtureClient(`
emit({ type: "result", command: "x", ok: false, data: {}, files: [], error: { message: "模板缺少『库存』工作表" } });
process.stderr.write("traceback line\\n".repeat(400)); process.exitCode = 4;
`);
    const message = (await failure(client.run(["x"], { timeoutMs: 5_000 }))).message;
    expect(message).toStartWith("模板缺少『库存』工作表\n[truncated] ");
    expect(Buffer.byteLength(message, "utf8")).toBeLessThan(4_200);
  });

  test("decodes a character split across two stderr writes", async () => {
    const { client } = fixtureClient(`
const bytes = Buffer.from("模板无法读取");
process.stderr.write(bytes.subarray(0, 2));
await new Promise(resolve => setTimeout(resolve, 50));
process.stderr.write(bytes.subarray(2)); process.exitCode = 1;
`);
    const message = (await failure(client.run(["x"], { timeoutMs: 5_000 }))).message;
    expect(message).toContain("模板无法读取");
    expect(message).not.toContain("�");
  });

  test("redacts short credential values but not switch values", async () => {
    const { client } = fixtureClient(`process.stderr.write("login refused for ab12x\\n"); process.exitCode = 1;`,
      { environment: () => ({ LXE_YACANG_PASSWORD: "ab12x", FIXTURE_CHILD_SESSION: "1", ZINIAO_PASSWORD: "T", FIXTURE_TOKEN: "true" }) });
    const message = (await failure(client.run(["x"], { timeoutMs: 5_000 }))).message;
    expect(message).toBe("lxeskill exited with code 1\nlogin refused for [redacted]");
  });

  test("reports the actual spawn failure for an absent executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cli-absent-"));
    try {
      const executablePath = join(root, "absent-lxeskill");
      const client = new LxeSkillClient({ executablePath, dataRoot: root, managedPath: "" });
      const message = (await failure(client.run(["list"], { timeoutMs: 5_000 }))).message;
      expect(message).toContain(executablePath);
      expect(message).toMatch(/ENOENT|not found/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("unwraps settings payloads and rejects results without one", async () => {
    const { client } = fixtureClient(`emit({ type: "result", command: "x", ok: true, data: args[0] === "good" ? { success: true, data: { a: 1 } } : { slots: [] }, files: [] });`);
    expect(settingsPayload(await client.run(["good"], { timeoutMs: 5_000 }))).toEqual({ a: 1 });
    expect(() => settingsPayload({ command: "x", data: { slots: [] }, files: [], record: { ok: true } }))
      .toThrow("Invalid lxeskill settings result");
  });

  test("runs the real source CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cli-real-"));
    try {
      const client = new LxeSkillClient({ executablePath: sourceLxeSkillPath(), dataRoot: root, managedPath: "" });
      const result = await client.run(["list"], { timeoutMs: 30_000, maxOutputBytes: 10 * 1024 * 1024 });
      expect(result.command).toBe("list");
      expect((result.data.commands as unknown[]).length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
