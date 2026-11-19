import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
for (const [name, fixture, marker] of [
  ["Electron stop RPC preserves bound plans and permits their next scheduled admission", "automation-stop", "automation-stop-routing-passed"],
  ["Electron send RPC replays attachment steering receipts before claiming draft files", "steering-receipts", "steering-receipts-passed"],
] as const) test(name, async () => {
  const root = mkdtempSync(join(tmpdir(), `lxe-${fixture}-`));
  try {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, `fixtures/${fixture}.electron.ts`)],
      outdir: root, naming: "fixture.cjs", target: "node", format: "cjs", external: ["electron"] });
    expect(built.success, built.logs.join("\n")).toBe(true);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = Bun.spawn([require("electron"), join(root, "fixture.cjs"), root], { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain(marker);
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
}, 20_000);
