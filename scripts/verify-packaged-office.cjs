const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { verifyOfficeRuntime } = require("./office-runtime.cjs");

function verifyPackagedOffice(appOutDir) {
  const root = join(appOutDir, "resources", "runtime");
  const verified = verifyOfficeRuntime(join(root, "office"), "win32-x64");
  const environment = { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
  for (const key of Object.keys(environment)) {
    if (["path", "pythonpath", "pythonhome", "node_path", "node_options"].includes(key.toLowerCase())) delete environment[key];
  }
  environment.PATH = [join(root, "node"), join(root, "python"), join(root, "tools")].join(";");
  const result = spawnSync(join(root, "python", "python.exe"), [
    "-I", join(__dirname, "verify-office-runtime.py"), "--runtime-root", root,
  ], { env: environment, encoding: "utf8", windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged Office validation failed (exit ${result.status}, signal ${result.signal}):\n${[result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n")}`);
  }
  console.log(`Verified packaged Office Kit ${verified.kitVersion}: ${result.stdout.trim()}`);
}

module.exports = async context => {
  await require("./verify-packaged-lark.cjs")(context);
  require("./file-preview-resources.cjs").verifyFilePreviewResources(join(context.appOutDir, "resources", "dashboard"));
  if (context.electronPlatformName !== "win32") return;
  if (process.platform !== "win32") throw new Error("Packaged Office validation requires Windows");
  require("./verify-packaged-lxeskill.cjs").verifyPackagedLxeSkill(context.appOutDir);
  verifyPackagedOffice(context.appOutDir);
};
module.exports.verifyPackagedOffice = verifyPackagedOffice;
