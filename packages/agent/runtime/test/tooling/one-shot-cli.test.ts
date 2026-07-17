import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OneShotCliRunner } from "../../src/tooling/one-shot-cli";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const runnerFor = (source: string, options: { stderr?: string[]; timeoutMs?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "lxe-one-shot-cli-"));
  roots.push(root);
  const script = join(root, "fixture.ts");
  writeFileSync(script, source, "utf8");
  return new OneShotCliRunner({
    command: [process.execPath, script],
    cwd: root,
    timeoutMs: options.timeoutMs ?? 5_000,
    maxOutputBytes: 64 * 1024,
    onStderr: (line) => options.stderr?.push(line),
  });
};

describe("OneShotCliRunner", () => {
  test("accepts progress JSONL followed by exactly one terminal result", async () => {
    const stderr: string[] = [];
    const runner = runnerFor(`
      console.error("diagnostic");
      console.log(JSON.stringify({protocol_version:"1",type:"progress",command:"auth refresh",step:"login",status:"running"}));
      console.log(JSON.stringify({protocol_version:"1",type:"result",command:"auth refresh",ok:true,data:{source:"cache"},files:[]}));
    `, { stderr });

    const result = await runner.execute(["auth", "refresh"], new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ source: "cache" });
    expect(stderr).toEqual(["diagnostic"]);
  });

  test("returns a failed terminal result with a stable nonzero CLI exit", async () => {
    const runner = runnerFor(`
      console.error("diagnostic");
      console.log(JSON.stringify({protocol_version:"1",type:"result",command:"auth refresh",ok:false,data:{},files:[],error:{code:"auth_failed",message:"failed"}}));
      process.exit(4);
    `);

    const result = await runner.execute([], new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("auth_failed");
    expect(result.error?.message).toBe("failed (exit 4): diagnostic");
  });

  test("rejects stdout pollution and duplicate terminal records", async () => {
    const polluted = runnerFor(`console.log("not json");`);
    await expect(polluted.execute([], new AbortController().signal)).rejects.toThrow();

    const duplicate = runnerFor(`
      const result = {protocol_version:"1",type:"result",command:"x",ok:true,data:{},files:[]};
      console.log(JSON.stringify(result));
      console.log(JSON.stringify(result));
    `);
    await expect(duplicate.execute([], new AbortController().signal)).rejects.toThrow("exactly one terminal");
  });

  test("preserves stderr when a broken Python environment emits no JSONL", async () => {
    const runner = runnerFor(`
      console.error("No module named lxeskill");
      process.exit(1);
    `);

    await expect(runner.execute([], new AbortController().signal)).rejects.toThrow(
      "lxeskill produced no JSONL result (exit 1): No module named lxeskill",
    );
  });

  test("terminates a timed out process", async () => {
    const runner = runnerFor(`await Bun.sleep(60_000);`, { timeoutMs: 10 });

    await expect(runner.execute([], new AbortController().signal)).rejects.toThrow("timed out");
  });
});
