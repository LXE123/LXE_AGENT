import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const node = process.env.LXE_OFFICE_NODE || Bun.which("node");
test.skipIf(!node)("bundled recurrence worker runs and recovers under Node without workspace dependencies", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-clock-bundle-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const name of ["automation-clock", "automation-time-worker"]) {
      const result = await Bun.build({ entrypoints: [join(import.meta.dir, `../../gateway/src/orchestration/${name}.ts`)],
        outdir: root, naming: `${name}.mjs`, target: "node", format: "esm" });
      expect(result.success, result.logs.join("\n")).toBe(true);
    }
    writeFileSync(join(root, "run.mjs"), `
      import assert from "node:assert/strict";
      import { AutomationClock } from "./automation-clock.mjs";
      const clock = new AutomationClock({ workerPath: new URL("./automation-time-worker.mjs", import.meta.url), timeoutMs: 500 });
      const now = Date.UTC(2026, 9, 23, 0, 1);
      const definition = rule => ({ name: "fixture", prompt: "report", timezone: "UTC", target: { mode: "new", workspace_id: "fixture" },
        schedule: { kind: "rrule", rule, start_at: now - 60000 } });
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      try {
        await assert.rejects(clock.preview(definition("FREQ=MINUTELY;BYSETPOS=2"), now), /exceeded 500ms; worker terminated/);
        assert.ok(ticks > 5);
        const result = await clock.preview(definition("FREQ=DAILY;BYHOUR=8"), now);
        assert.equal(result.times.length, 5);
        assert.equal(result.times[0], Date.UTC(2026, 9, 23, 8));
      } finally { clearInterval(timer); await clock.close(); }
      console.log("clock-bundle-passed");
    `);
    child = Bun.spawn([node!, join(root, "run.mjs")], { cwd: root, stdout: "pipe", stderr: "pipe" });
    timer = setTimeout(() => child?.kill(), 10_000);
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0); expect(stdout).toContain("clock-bundle-passed");
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
