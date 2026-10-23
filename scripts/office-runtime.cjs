const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));

// Also used by the packaging hook. Verify the upstream inventory, including
// licenses, source recipes, fonts and the native program's supporting resources.
function verifyOfficeRuntime(root, platform) {
  if (!["darwin-arm64", "darwin-x64", "win32-x64"].includes(platform)) {
    throw new Error(`Unsupported LXE Office platform: ${platform}`);
  }
  const scope = join(root, "node_modules", "@deepseek-ai");
  const kit = readJson(join(scope, "libreoffice-kit", "package.json"));
  if (kit.version !== "0.1.5") throw new Error(`Unexpected Office Kit version: ${kit.version}`);
  const engineName = `@deepseek-ai/libreoffice-kit-${platform}`;
  const engineRoot = resolve(scope, `libreoffice-kit-${platform}`);
  const engine = readJson(join(engineRoot, "package.json"));
  const inventory = readJson(join(engineRoot, "prebuilds.json"));
  if (engine.name !== engineName || engine.version !== kit.optionalDependencies[engineName]
      || inventory.version !== engine.version || inventory.platform !== platform
      || inventory.schemaVersion !== 1 || inventory.status !== "built" || inventory.engine?.kind !== "native") {
    throw new Error(`Incompatible Office engine: ${engineRoot}`);
  }
  const asset = name => {
    const path = resolve(engineRoot, name);
    if (!path.startsWith(engineRoot + sep)) throw new Error(`Office asset escapes engine directory: ${name}`);
    return path;
  };
  const entries = Object.entries(inventory.files ?? {});
  if (!entries.length || !inventory.source?.files?.length || !inventory.licenses?.length) {
    throw new Error(`Incomplete Office inventory: ${engineRoot}`);
  }
  for (const [name, expected] of entries) {
    if (sha256(readFileSync(asset(name))) !== expected) throw new Error(`Office asset checksum mismatch: ${name}`);
  }
  for (const name of [inventory.engine.executable, ...inventory.source.files, ...inventory.licenses.map(item => item.path)]) {
    if (!inventory.files[name]) throw new Error(`Office asset missing from inventory: ${name}`);
  }
  if (!statSync(asset(inventory.engine.programDirectory)).isDirectory()) throw new Error("Office program directory is missing");
  const cli = join(scope, "libreoffice-kit", "lib", "cli.js");
  if (!statSync(cli).isFile()) throw new Error(`Office CLI is missing: ${cli}`);
  return { cli, kitVersion: kit.version, engineVersion: engine.version, platform, verifiedFiles: entries.length };
}

module.exports = { verifyOfficeRuntime, sha256 };
