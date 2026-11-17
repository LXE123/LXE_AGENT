import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { planTabSuspension, RECENT_SELECTION_MS } from "../src/main/manual-tools/tab-budget";

test("window budget counts only live background pages and protects busy and recently selected tabs", () => {
  const pages = Array.from({ length: 35 }, (_, i) => ({ id: String(i), sessionId: String(i % 2), busy: false, visible: i === 34, lastUsed: i }));
  pages[0]!.busy = true;
  const selected = new Map([["1", { id: "1", at: 100 }]]);
  expect(planTabSuspension(pages.slice(0, 32), selected, undefined, 110).victims).toEqual([]);
  expect(planTabSuspension(pages, selected, undefined, 110).victims).toEqual(["2", "3"]);
  expect(planTabSuspension(pages.map(p => ({ ...p, busy: true })), selected, undefined, 110).victims).toEqual([]);
  expect(planTabSuspension(pages, selected, undefined, 110).retryAt).toBe(100 + RECENT_SELECTION_MS);
});

test("sidebar webview survives menus and restores its history after budget suspension", async () => {
  const profile = mkdtempSync(resolve(tmpdir(), "lxe-browser-frame-"));
  try {
    const built = await Bun.build({ entrypoints: [resolve(import.meta.dirname, "fixtures/browser-frame.electron.ts"), resolve(import.meta.dirname, "../src/preload.ts"), resolve(import.meta.dirname, "../src/team-skills-preload.ts")],
      outdir: profile, naming: "[name].cjs", target: "node", format: "cjs", external: ["electron"] });
    expect(built.success, built.logs.join("\n")).toBe(true);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = Bun.spawn([createRequire(import.meta.url)("electron"), resolve(profile, "browser-frame.electron.cjs"), profile],
      { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 110000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + "\n" + stderr).toBe(0);
      expect(stdout).toContain("BROWSER_FRAME_OK: menu, shared 32/33 budget, catalog and sidebar history, cleanup");
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); }
}, 120000);
