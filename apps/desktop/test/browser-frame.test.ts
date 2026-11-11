import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { parseManualToolCall } from "@lxe/desktop-protocol";

test("browser clipping rejects malformed rectangles and radii", () => {
  const input = { sessionId: "s", id: "b", bounds: { x: 50, y: 40, width: 400, height: 300 },
    clip: { x: 50, y: 40, width: 400, height: 300, radius: 13 } };
  expect(parseManualToolCall({ operation: "browser.present", input }).input).toEqual(input);
  for (const clip of [null, {}, { ...input.clip, x: NaN }, { ...input.clip, radius: -1 }, { ...input.clip, height: -1 }]) {
    expect(() => parseManualToolCall({ operation: "browser.present", input: { ...input, clip } })).toThrow("Invalid browser clip");
  }
});

test("native browser follows frame bounds and preserves its viewport, input and lifecycle", async () => {
  const profile = mkdtempSync(resolve(tmpdir(), "lxe-browser-frame-"));
  try {
    const built = await Bun.build({ entrypoints: [resolve(import.meta.dirname, "fixtures/browser-frame.electron.ts")],
      outdir: profile, naming: "runner.cjs", target: "node", format: "cjs", external: ["electron"] });
    expect(built.success, built.logs.join("\n")).toBe(true);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = Bun.spawn([createRequire(import.meta.url)("electron"), resolve(profile, "runner.cjs"), profile],
      { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + "\n" + stderr).toBe(0);
      expect(stdout).toContain("BROWSER_FRAME_OK: clipping, zoom, renderer input, viewport, hide and cleanup");
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); }
}, 40000);
