import { resolve } from "node:path";
import { prepareMacExifTool } from "./prepare-desktop-macos-exiftool";

const repositoryRoot = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin") {
  throw new Error(`Mac desktop media verification requires darwin, received ${process.platform}`);
}

const prepared = await prepareMacExifTool({ repositoryRoot });
const child = Bun.spawn([
  "uv",
  "run",
  "--frozen",
  "pytest",
  "-q",
  "python/lxeskill_cli/tests/media/test_synthetic_performer.py",
  "-k",
  "real_exiftool",
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    LXE_EXIFTOOL_PATH: prepared.exifToolPath,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`Mac desktop media verification exited with ${exitCode}`);
