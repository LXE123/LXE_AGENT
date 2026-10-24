import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Build an entry point that survives moving the application's private Python. */
export function prepareLxeSkillLauncher(options: {
  python: string;
  wheel: string;
  destination: string;
  uv?: string;
  platform?: NodeJS.Platform;
}): void {
  const platform = options.platform ?? process.platform;
  mkdirSync(dirname(options.destination), { recursive: true });
  if (platform !== "win32") {
    // Packaged layout: runtime/python/bin/{python3,lxeskill}.
    writeFileSync(options.destination, `#!/bin/sh
entry_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit
exec "$entry_dir/python3" -I -B -X utf8 -m lxeskill "$@"
`);
    chmodSync(options.destination, 0o755);
    return;
  }
  if (process.platform !== "win32") throw new Error("Build the Windows lxeskill entry point on Windows");
  const staging = mkdtempSync(join(dirname(options.destination), ".lxeskill-entry-"));
  const run = (args: string[]) => {
    const result = Bun.spawnSync([options.uv ?? "uv", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    if (result.exitCode !== 0) throw new Error(`lxeskill entry point build failed (${result.exitCode}):\n${result.stderr.toString()}\n${result.stdout.toString()}`);
  };
  try {
    const venv = join(staging, "venv");
    run(["venv", "--relocatable", "--no-project", "--python", options.python, venv]);
    run(["pip", "install", "--python", join(venv, "Scripts", "python.exe"), "--offline", "--no-deps", options.wheel]);
    // uv's relocatable console launcher resolves python.exe beside itself. Copy
    // only that entry point, never a venv, its interpreter or editable .pth files.
    // Placing it beside the real private Python removes all build-machine paths.
    copyFileSync(join(venv, "Scripts", "lxeskill.exe"), options.destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
