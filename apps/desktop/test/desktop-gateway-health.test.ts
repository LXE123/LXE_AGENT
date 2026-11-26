import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LxeSkillClient, type LxeSkillClientOptions } from "../src/main/lxeskill-client";
import { DesktopLxeSkillHealth } from "../src/main/lxeskill-health";
import { fixtureClient, removeFixtures, sourceLxeSkillPath } from "./support/lxeskill-fixture";

const roots: string[] = [];
const services: DesktopLxeSkillHealth[] = [];
const listResult = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ protocol_version: "1", type: "result", command: "list", ok: true, data: { commands: [] }, files: [], ...fields });
type Options = Omit<ConstructorParameters<typeof DesktopLxeSkillHealth>[0], "client">;
const healthFor = (client: LxeSkillClient, overrides: Partial<Options> = {}) => {
  const service = new DesktopLxeSkillHealth({ client, recovery: "repair CLI", ...overrides });
  services.push(service); return service;
};
/** A health check whose CLI prints `stdout`, then `stderr`, and exits with `code`. */
const fixtureHealth = (stdout: string, code = 0, stderr = "fixture diagnostic", options: Partial<LxeSkillClientOptions> = {}) =>
  healthFor(fixtureClient(`process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};`, options).client);
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  removeFixtures();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop lxeskill health", () => {
  test("runs the public list command without Agent DB, private skill or database override paths", async () => {
    const states: string[] = [];
    const { client } = fixtureClient(`
const env = process.env;
const leaked = ["LXE_AGENT_SQLITE_DB_PATH", "LXE_USER_SKILLS_ROOT", "LXE_SQLITE_DB_PATH"].filter(name => name in env);
if (args.join(" ") !== "list" || env.PYTHONNOUSERSITE !== "1" || leaked.length) { console.error("unexpected launch", args, leaked); process.exit(9); }
emit({ type: "result", command: "list", ok: true, data: { commands: [] }, files: [] });
`, { environment: () => ({ ...process.env, LXE_AGENT_SQLITE_DB_PATH: "/private/agent.sqlite3", LXE_USER_SKILLS_ROOT: "/private/skills", LXE_SQLITE_DB_PATH: "/business.sqlite3" }) });
    const service = healthFor(client, { onChanged: () => states.push(service.snapshot().state) });
    expect(service.snapshot().state).toBe("stopped");
    const pending = service.check();
    expect(service.check()).toBe(pending);
    expect(service.snapshot().state).toBe("starting");
    await pending;
    expect(states).toEqual(["starting", "ready"]);
    expect(service.snapshot()).toEqual({ state: "ready", message: "" });
  });

  test("reports actual CLI failures and can recheck successfully after repair", async () => {
    const { client, root } = fixtureClient("");
    const marker = join(root, "repaired");
    const runner = join(root, "lxeskill-fixture.mjs");
    writeFileSync(runner, `
const { existsSync } = await import("node:fs");
if (existsSync(${JSON.stringify(marker)})) {
  process.stdout.write(${JSON.stringify(listResult())});
} else {
  process.stdout.write(${JSON.stringify(listResult({ ok: false, data: {}, error: { code: "bad_catalog", message: "fixture missing command_path" } }))});
  process.stderr.write("fixture validation traceback"); process.exitCode = 2;
}
`, "utf8");
    const service = healthFor(client);
    await expect(service.check()).resolves.toBeUndefined();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain("fixture missing command_path");
    expect(service.snapshot().message).toContain("fixture validation traceback");
    expect(service.snapshot().message).toEndWith("repair CLI");
    writeFileSync(marker, "");
    await service.check();
    expect(service.snapshot()).toEqual({ state: "ready", message: "" });
  });

  test.each(["", "not json", "null", `${listResult()}\n${listResult()}`,
    listResult().replace('"1"', '"2"'), listResult().replace('"list"', '"doctor"'),
    listResult().replace('"commands":[]', '"commands":null')])("rejects invalid or inconsistent list output: %s", async stdout => {
    const service = fixtureHealth(stdout);
    await service.check();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain("LXE Skill CLI is unavailable");
  });

  test("does not report ready after a nonzero exit even if stdout claims success", async () => {
    const service = fixtureHealth(listResult(), 3);
    await service.check();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain("lxeskill exited with code 3");
  });

  test("cancels a pending probe and ignores its stale completion after a new check", async () => {
    const { client, root } = fixtureClient("");
    const started = join(root, "started");
    writeFileSync(join(root, "lxeskill-fixture.mjs"), `
const { existsSync, writeFileSync } = await import("node:fs");
if (!existsSync(${JSON.stringify(started)})) { writeFileSync(${JSON.stringify(started)}, ""); setInterval(() => {}, 1_000); }
else process.stdout.write(${JSON.stringify(listResult())});
`, "utf8");
    const service = healthFor(client);
    const first = service.check();
    const deadline = Date.now() + 5_000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const stopping = service.stop();
    expect(service.snapshot().state).toBe("stopped");
    await Promise.all([first, stopping]);
    await service.check();
    expect(service.snapshot()).toEqual({ state: "ready", message: "" });
  });

  test("redacts configured secrets and explicitly truncates actual diagnostics", async () => {
    const service = fixtureHealth("", 1, "x".repeat(5000) + " actual refusal fixture-sensitive-token",
      { environment: () => ({ ...process.env, API_TOKEN: "fixture-sensitive-token" }) });
    await service.check();
    expect(service.snapshot().message).toContain("[truncated]");
    expect(service.snapshot().message).toContain("actual refusal [redacted]");
    expect(service.snapshot().message).not.toContain("fixture-sensitive-token");
  });

  test("probes the real installed CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-cli-health-")); roots.push(root);
    const service = healthFor(new LxeSkillClient({ executablePath: sourceLxeSkillPath(), dataRoot: root, managedPath: "" }));
    await service.check();
    expect(service.snapshot()).toEqual({ state: "ready", message: "" });
  }, 30_000);

  test("reports the actual spawn failure for an absent executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-cli-health-")); roots.push(root);
    const executablePath = join(root, "absent-lxeskill");
    const service = healthFor(new LxeSkillClient({ executablePath, dataRoot: root, managedPath: "" }));
    await service.check();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain(executablePath);
    expect(service.snapshot().message).toMatch(/ENOENT|not found/u);
  });

  test("terminates a hung subprocess at the probe deadline", async () => {
    const service = healthFor(fixtureClient("setInterval(() => {}, 1_000);").client, { timeoutMs: 100 });
    await service.check();
    expect(service.snapshot().state).toBe("error");
    expect(service.snapshot().message).toContain("lxeskill timed out after 100ms");
  });
});
