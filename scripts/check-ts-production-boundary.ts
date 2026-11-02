import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const failures: string[] = [];

const bundleRoot = mkdtempSync(join(tmpdir(), "lxe-agent-cli-boundary-"));
try {
  const metafile = join(bundleRoot, "metafile.json");
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      "apps/agent-cli/src/main.ts",
      "--target=bun",
      `--outdir=${join(bundleRoot, "dist")}`,
      `--metafile=${metafile}`,
    ],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    failures.push(`agent-cli bundle check failed: ${result.stderr.toString().trim()}`);
  } else {
    const metadata = JSON.parse(readFileSync(metafile, "utf8")) as { inputs?: Record<string, unknown> };
    const inputs = Object.keys(metadata.inputs ?? {});
    if (inputs.length === 0) failures.push("agent-cli bundle metadata has no inputs");
    const gatewayInputs = inputs.filter((path) =>
      path.replaceAll("\\", "/").includes("apps/gateway/src/"));
    if (gatewayInputs.length > 0) {
      failures.push(`agent-cli bundle contains Gateway modules: ${gatewayInputs.join(", ")}`);
    }
  }
} finally {
  rmSync(bundleRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("Agent CLI bundle boundary OK");
