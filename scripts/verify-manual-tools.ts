import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
const root = resolve(import.meta.dirname, ".."), output = mkdtempSync(join(tmpdir(), "lxe-manual-build-"));
const { build } = await import(createRequire(join(root, "apps/dashboard/package.json")).resolve("vite"));
await build({ root: join(root, "apps/dashboard/test/features/manual-tools"), base: "./", configFile: false, build: { outDir: output, emptyOutDir: true, chunkSizeWarningLimit: 20000 }, logLevel: "warn" });
const bundle = await Bun.build({ entrypoints: [join(root, "apps/desktop/test/fixtures/manual-tools.electron.ts")], outdir: join(output, "main"), target: "node", format: "cjs", external: ["electron"] });
if (!bundle.success) throw new Error(bundle.logs.map(String).join("\n"));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const electron = createRequire(import.meta.url)(join(root, "apps/desktop/node_modules/electron"));
const profile = mkdtempSync(join(tmpdir(), "lxe-manual-native-"));
const args = [electron, bundle.outputs[0]!.path, join(output, "index.html"), resolve(process.env.LXE_MANUAL_TEST_DIST || join(root, "apps/desktop/dist")), profile];
for (const phase of ["initial", "restart"]) {
  const child = Bun.spawn([...args, phase], { env, stdout: "pipe", stderr: "inherit" });
  const timer = setTimeout(() => child.kill(), 110000);
  try {
    const [status, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    process.stdout.write(text);
    if (status !== 0 || !text.includes("LXE_MANUAL_RESULT=")) throw new Error(`Native manual tools ${phase} did not finish successfully (exit ${status})`);
  } finally { clearTimeout(timer); }
}
