import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);

test("Electron persists and reconciles automation dispatches after process exit, then releases SQLite and Worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-automation-electron-"));
  const bundle = join(root, "bundle with spaces"), data = join(root, "数据 with spaces");
  mkdirSync(bundle); mkdirSync(data);
  try {
    for (const [entry, naming, format] of [
      [join(import.meta.dir, "fixtures/automation-electron.ts"), "fixture.cjs", "cjs"],
      [join(import.meta.dir, "../../gateway/src/orchestration/automation-time-worker.ts"), "automation-time-worker.mjs", "esm"],
    ] as const) {
      const result = await Bun.build({ entrypoints: [entry], outdir: bundle, naming, target: "node", format, external: ["electron"] });
      expect(result.success, result.logs.join("\n")).toBe(true);
    }
    for (const phase of ["interrupt", "recover"]) {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = Bun.spawn([require("electron"), join(bundle, "fixture.cjs"), root, phase],
        { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 15_000);
      try {
        const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(exit, `${stdout}\n${stderr}`).toBe(phase === "interrupt" ? 23 : 0);
        expect(stdout).toContain(`automation-electron-${phase}-passed`);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) { child.kill(); await child.exited; }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
}, 40_000);
