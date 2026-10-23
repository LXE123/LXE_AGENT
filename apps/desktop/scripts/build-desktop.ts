import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDesktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface DesktopBuildOptions {
  desktopRoot?: string;
  outputRoot?: string;
}

const runBuild = (desktopRoot: string, arguments_: string[]): void => {
  const result = spawnSync(process.execPath, ["build", ...arguments_], {
    cwd: desktopRoot,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Desktop build failed with exit code ${result.status ?? "unknown"}`);
  }
};

export function buildDesktop(options: DesktopBuildOptions = {}): void {
  const desktopRoot = resolve(options.desktopRoot ?? defaultDesktopRoot);
  const outputRoot = resolve(options.outputRoot ?? join(desktopRoot, "dist"));
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  runBuild(desktopRoot, [join(desktopRoot, "src", "main", "manual-tools", "pty-host.ts"), "--outfile", join(outputRoot, "pty-host.cjs"), "--target", "node", "--format", "cjs", "--external", "node-pty"]);
  runBuild(desktopRoot, [join(desktopRoot, "src", "mcp", "server.ts"), "--outfile", join(outputRoot, "desktop-mcp.mjs"), "--target", "node", "--format", "esm"]);
  // node-pty's packaged Node-API binaries work across Electron ABIs. Keep native helpers outside ASAR.
  const nativeRoot = join(outputRoot, "pty-runtime");
  const installed = dirname(fileURLToPath(import.meta.resolve("node-pty/package.json")));
  mkdirSync(nativeRoot, { recursive: true });
  for (const entry of ["lib", "package.json", "LICENSE"]) cpSync(join(installed, entry), join(nativeRoot, entry), { recursive: true });
  cpSync(join(installed, "prebuilds", `${process.platform}-${process.arch}`), join(nativeRoot, "prebuilds", `${process.platform}-${process.arch}`), { recursive: true, filter: path => !path.endsWith(".pdb") });
  if (process.platform !== "win32") {
    const helper = join(nativeRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
  runBuild(desktopRoot, [
    join(desktopRoot, "src", "main.ts"),
    "--outfile",
    join(outputRoot, "main.js"),
    "--target",
    "node",
    "--format",
    "esm",
    "--external",
    "electron",
    "--external",
    "node:sqlite",
  ]);
  runBuild(desktopRoot, [
    join(desktopRoot, "src", "preload.ts"),
    "--outfile",
    join(outputRoot, "preload.cjs"),
    "--target",
    "node",
    "--format",
    "cjs",
    "--external",
    "electron",
  ]);
}

if (import.meta.main) buildDesktop();
