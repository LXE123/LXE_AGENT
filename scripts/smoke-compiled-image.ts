import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lxe-compiled-image-"));
const executable = join(root, process.platform === "win32" ? "image-smoke.exe" : "image-smoke");
const output = join(root, "处理结果.jpg");
const fixture = resolve(
  import.meta.dir,
  "../skills/replenishment-amazon-fba-inventory-snapshot/assets/amazon_fba_inventory_download_step_1_menu.jpg",
);

try {
  const build = Bun.spawn([
    process.execPath,
    "build",
    "--compile",
    resolve(import.meta.dir, "../apps/gateway/src/image-compile-smoke.ts"),
    "--outfile",
    executable,
  ], { stdout: "inherit", stderr: "inherit" });
  if (await build.exited !== 0) throw new Error("compiled Bun.Image smoke build failed");
  const run = Bun.spawn([executable, fixture, output], { stdout: "pipe", stderr: "inherit" });
  const stdout = await new Response(run.stdout).text();
  if (await run.exited !== 0) throw new Error("compiled Bun.Image smoke executable failed");
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  if (payload.format !== "jpeg" || payload.mime !== "image/jpeg" || Number(payload.width) > 1_024 || Number(payload.height) > 1_024) {
    throw new Error(`compiled Bun.Image smoke returned invalid output: ${stdout.trim()}`);
  }
  process.stdout.write(`Compiled Bun.Image smoke OK: ${stdout.trim()}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
