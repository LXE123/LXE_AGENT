const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// Exercise the shipped entry point through PATH, away from the source checkout.
function verifyPackagedLxeSkill(appOutDir) {
  const python = join(appOutDir, "resources", "runtime", "python");
  const data = mkdtempSync(join(tmpdir(), "lxe-packaged-cli-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["path", "pythonpath", "pythonhome", "virtual_env"].includes(key.toLowerCase()) || key.startsWith("LXE_")) delete env[key];
  }
  Object.assign(env, {
    PATH: process.platform === "win32" ? python : `${join(python, "bin")}:/usr/bin:/bin`,
    LXE_DATA_ROOT: data, PYTHONUTF8: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
  });
  try {
    const result = spawnSync(process.platform === "win32" ? "lxeskill.exe" : "lxeskill", ["list"], {
      cwd: data, env, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Packaged lxeskill failed (exit ${result.status}): ${[result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 4000)}`);
    }
    const records = result.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
    const terminal = records.at(-1);
    if (terminal?.type !== "result" || terminal.protocol_version !== "1" || terminal.command !== "list"
      || terminal.ok !== true || !terminal.data?.commands?.length) {
      throw new Error(`Packaged lxeskill returned an invalid list: ${result.stdout.slice(0, 4000)}`);
    }
    console.log(`Verified packaged lxeskill entry point (${terminal.data.commands.length} commands)`);
  } finally { rmSync(data, { recursive: true, force: true }); }
}
module.exports = { verifyPackagedLxeSkill };
