import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { build } from "vite";

let server: ReturnType<typeof Bun.serve> | undefined;
let output: string;
let url: string;
const require = createRequire(import.meta.url);
beforeAll(async () => {
  output = mkdtempSync(resolve(tmpdir(), "lxe-renderer-build-"));
  await build({ root: resolve(import.meta.dirname, "../.."), logLevel: "error",
    build: { outDir: output, emptyOutDir: true, target: "es2022", minify: false,
      rollupOptions: { input: [resolve(import.meta.dirname, "renderer.html"), resolve(import.meta.dirname, "../features/sessions/window-fixture.html")] } } });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = resolve(output, "." + new URL(request.url).pathname);
    if (!path.startsWith(output + sep)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  url = `http://127.0.0.1:${server.port}/test/behavior/renderer.html`;
}, 60_000);
afterAll(() => { server?.stop(true); if (output) rmSync(output, { recursive: true, force: true }); });

for (const suite of ["conversation-content", "conversation-window", "dashboard-pages", "markdown", "session-workspace", "app-actions", "conversation-events", "dialog", "composer", "references", "readiness", "sidebar", "windows-titlebar", "windows-menu", "workspaces", "mermaid", "permissions", "updates", "vietnam-settings"] as const) {
  test(`Chromium renderer behavior: ${suite}`, async () => {
    const profile = mkdtempSync(resolve(tmpdir(), "lxe-renderer-test-"));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = Bun.spawn([
      require(resolve(import.meta.dirname, "../../../desktop/node_modules/electron")),
      // Electron on Windows rejects arguments after a URL; keep the URL last.
      resolve(import.meta.dirname, "runner.cjs"), suite, profile, url,
    ], { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 45_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode, `Renderer ${suite}\n${stdout}\n${stderr}`).toBe(0);
      const line = stdout.split("\n").find(line => line.startsWith("LXE_BEHAVIOR_RESULT="));
      expect(line, `Renderer did not report completed scenarios\n${stdout}\n${stderr}`).toBeDefined();
      const report = JSON.parse(line!.slice("LXE_BEHAVIOR_RESULT=".length));
      expect(report.suite).toBe(suite);
      expect(report.passed).toHaveLength({ "conversation-content": 4, "conversation-window": 3, "dashboard-pages": 9, markdown: 6, "session-workspace": 9, "app-actions": 5, "conversation-events": 4, dialog: 3, composer: 5, references: 13, readiness: 5, sidebar: 6, "windows-titlebar": 2, "windows-menu": 2, workspaces: 15, mermaid: 3, permissions: 10, updates: 4, "vietnam-settings": 8 }[suite]);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
}
