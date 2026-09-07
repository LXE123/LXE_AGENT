import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkFdVersion, FD_VERSION } from "../packages/agent/runtime/src/tooling/fd-search";

export interface FdLock { version: string; platforms: Record<string, { archive_url: string; archive_sha256: string }> }
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export async function prepareDesktopFd(options: {
  repositoryRoot?: string; platform?: string; arch?: string;
  download?: (url: string, destination: string) => Promise<void>;
  extract?: (archive: string, destination: string) => void;
  checkVersion?: (path: string) => void;
} = {}): Promise<{ path: string; status: "cached" | "prepared" }> {
  const root = options.repositoryRoot ?? resolve(import.meta.dirname, "..");
  const platform = options.platform ?? process.platform;
  const target = `${platform}-${options.arch ?? process.arch}`;
  const lock = JSON.parse(readFileSync(join(root, "config/desktop-runtime/fd.lock.json"), "utf8")) as FdLock;
  const asset = lock.platforms[target];
  if (lock.version !== FD_VERSION) throw new Error(`fd lock version must match runtime ${FD_VERSION}`);
  if (!asset || !/^https:\/\//.test(asset.archive_url) || !/^[a-f0-9]{64}$/.test(asset.archive_sha256)) throw new Error(`Invalid or unsupported fd lock target: ${target}`);
  const tools = join(root, "build/desktop-runtime", target, "tools");
  const name = platform === "win32" ? "fd.exe" : "fd";
  const executable = join(tools, name);
  const markerPath = join(tools, ".fd.json");
  const check = options.checkVersion ?? checkFdVersion;
  if (existsSync(executable) && existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (marker.archive_sha256 === asset.archive_sha256 && marker.binary_sha256 === sha256(executable)) {
        check(executable); return { path: executable, status: "cached" };
      }
    } catch { /* Rebuild invalid cache in staging. */ }
  }
  mkdirSync(tools, { recursive: true });
  const stage = mkdtempSync(join(tools, ".fd-stage-"));
  try {
    const archive = join(stage, platform === "win32" ? "fd.zip" : "fd.tar.gz");
    await (options.download ?? (async (url, destination) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`fd download failed: HTTP ${response.status} ${url}`);
      await Bun.write(destination, response);
    }))(asset.archive_url, archive);
    const actual = sha256(archive);
    if (actual !== asset.archive_sha256) throw new Error(`fd archive SHA-256 mismatch: expected ${asset.archive_sha256}, received ${actual}`);
    const unpacked = join(stage, "unpacked"); mkdirSync(unpacked);
    (options.extract ?? ((source, destination) => {
      const result = Bun.spawnSync([platform === "win32" ? "tar.exe" : "tar", "-xf", source, "-C", destination], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`fd extraction failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
    }))(archive, unpacked);
    const binaries = readdirSync(unpacked, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name === name);
    if (binaries.length !== 1) throw new Error(`fd archive must contain exactly one ${name}`);
    const binary = join(binaries[0]!.parentPath, name);
    if (platform !== "win32") chmodSync(binary, 0o755);
    check(binary);
    const marker = { version: lock.version, archive_sha256: asset.archive_sha256, binary_sha256: sha256(binary) };
    // Publish only after extraction and verification have completed.
    renameSync(binary, executable);
    const stagedMarker = join(stage, "marker.json"); writeFileSync(stagedMarker, JSON.stringify(marker));
    renameSync(stagedMarker, markerPath);
    return { path: executable, status: "prepared" };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (import.meta.main) console.log(await prepareDesktopFd());
