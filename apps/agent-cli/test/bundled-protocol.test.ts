import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import validJob from "../../../packages/foundation/protocol/fixtures/valid-agent-job.json";

test("bundled CLI resolves shared schemas locally and validates jobs over JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lxe-bundled-protocol-"));
  try {
    const build = Bun.spawn([process.execPath, "build", "src/main.ts", "--outdir", directory, "--target", "bun"], {
      cwd: new URL("../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
    });
    const [buildOutput, buildError, buildCode] = await Promise.all([
      new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited,
    ]);
    if (buildCode !== 0) throw new Error(`agent-cli build failed (${buildCode}): ${buildOutput}${buildError}`);
    const bundle = join(directory, "main.js");
    // The generator stays a development dependency, not part of the executable.
    expect(await readFile(bundle, "utf8")).not.toContain("Generated protocol types are stale or edited");
    const calls = [
      { jsonrpc: "2.0", id: "valid", method: "run_turn", params: { run_id: "run-1", job: validJob } },
      { jsonrpc: "2.0", id: "invalid", method: "run_turn", params: { run_id: "run-2", job: { ...validJob, workspace: { ...validJob.workspace, extra: true } } } },
    ];
    const child = Bun.spawn([process.execPath, bundle, "serve", "--input-format", "stream-json", "--output-format", "stream-json"], {
      cwd: directory,
      env: { ...process.env, LOCAL_LOGS_ENABLED: "0", LOG_LEVEL: "ERROR" },
      stdin: new Blob([JSON.stringify(calls) + "\n"]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("can't resolve reference");
    const responses = stdout.trim().split("\n").flatMap((line) => JSON.parse(line));
    // A valid job passes schema validation, then hits the intentional initialization guard.
    expect(responses).toContainEqual(expect.objectContaining({ id: "valid", error: expect.objectContaining({ code: -32001 }) }));
    expect(responses).toContainEqual(expect.objectContaining({ id: "invalid", error: expect.objectContaining({ code: -32602 }) }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
