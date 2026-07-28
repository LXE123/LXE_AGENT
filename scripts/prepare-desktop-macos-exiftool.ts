import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface MacExifToolLock {
  version: string;
  archive_url: string;
  archive_sha256: string;
  archive_root: string;
}

export interface PrepareMacExifToolOptions {
  repositoryRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  perlPath?: string;
  runtimeRoot?: string;
  lock?: MacExifToolLock;
  downloadArchive?: (url: string, destination: string) => Promise<void>;
  extractArchive?: (archive: string, destination: string, lock: MacExifToolLock) => void;
}

export interface PreparedMacExifTool {
  status: "cached" | "prepared" | "skipped";
  exifToolPath: string;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const lockPath = join(repositoryRoot, "config", "desktop-runtime", "macos", "exiftool.lock.json");
const markerName = ".lxe-exiftool.json";

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const outputText = (value: Uint8Array): string => new TextDecoder().decode(value).trim();

const validateLock = (lock: MacExifToolLock): void => {
  if (!/^\d+\.\d+$/u.test(lock.version)) throw new Error("Mac ExifTool lock has an invalid version");
  if (!/^https:\/\//u.test(lock.archive_url)) throw new Error("Mac ExifTool lock has an invalid archive URL");
  if (!/^[a-f0-9]{64}$/u.test(lock.archive_sha256)) {
    throw new Error("Mac ExifTool lock has an invalid SHA-256");
  }
  if (lock.archive_root !== `Image-ExifTool-${lock.version}`) {
    throw new Error("Mac ExifTool lock has an invalid archive root");
  }
};

const readLock = (path: string): MacExifToolLock => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MacExifToolLock;
  } catch (error) {
    throw new Error(`Could not read the Mac ExifTool lock: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const macExifToolRoot = (
  root = repositoryRoot,
  arch = process.arch,
): string => join(root, "build", "desktop-runtime", `darwin-${arch}`, "tools", "exiftool");

export const macExifToolPath = (
  root = repositoryRoot,
  arch = process.arch,
): string => join(macExifToolRoot(root, arch), "exiftool");

const downloadArchive = async (url: string, destination: string): Promise<void> => {
  const curlPath = "/usr/bin/curl";
  if (!existsSync(curlPath)) throw new Error(`Mac curl is unavailable: ${curlPath}`);
  const result = Bun.spawnSync([
    curlPath,
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--retry",
    "3",
    "--output",
    destination,
    url,
  ], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = outputText(result.stderr) || outputText(result.stdout) || `curl exited with ${result.exitCode}`;
    throw new Error(`Could not download Mac ExifTool: ${detail}`);
  }
};

const extractArchive = (archive: string, destination: string, lock: MacExifToolLock): void => {
  const result = Bun.spawnSync([
    "tar",
    "-xzf",
    archive,
    "-C",
    destination,
    "--strip-components=1",
    `${lock.archive_root}/exiftool`,
    `${lock.archive_root}/lib`,
  ], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = outputText(result.stderr) || outputText(result.stdout) || `tar exited with ${result.exitCode}`;
    throw new Error(`Could not extract Mac ExifTool: ${detail}`);
  }
};

const expectedMarker = (lock: MacExifToolLock): Record<string, string> => ({
  version: lock.version,
  archive_sha256: lock.archive_sha256,
});

const layoutExists = (root: string): boolean =>
  existsSync(join(root, "exiftool")) && existsSync(join(root, "lib", "Image", "ExifTool.pm"));

const installedVersion = (root: string, perlPath: string): string => {
  const result = Bun.spawnSync([perlPath, join(root, "exiftool"), "-ver"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = outputText(result.stderr) || outputText(result.stdout) || `Perl exited with ${result.exitCode}`;
    throw new Error(`Could not start Mac ExifTool: ${detail}`);
  }
  return outputText(result.stdout);
};

const cacheReady = (root: string, perlPath: string, lock: MacExifToolLock): boolean => {
  if (!layoutExists(root)) return false;
  try {
    const marker = JSON.parse(readFileSync(join(root, markerName), "utf8")) as Record<string, unknown>;
    const expected = expectedMarker(lock);
    return marker.version === expected.version
      && marker.archive_sha256 === expected.archive_sha256
      && installedVersion(root, perlPath) === lock.version;
  } catch {
    return false;
  }
};

export async function prepareMacExifTool(
  options: PrepareMacExifToolOptions = {},
): Promise<PreparedMacExifTool> {
  const platform = options.platform ?? process.platform;
  const root = options.repositoryRoot ?? repositoryRoot;
  const arch = options.arch ?? process.arch;
  const toolRoot = options.runtimeRoot ?? macExifToolRoot(root, arch);
  const executable = join(toolRoot, "exiftool");
  if (platform !== "darwin") return { status: "skipped", exifToolPath: executable };

  const perlPath = options.perlPath ?? "/usr/bin/perl";
  if (!existsSync(perlPath)) throw new Error(`Mac Perl runtime is unavailable: ${perlPath}`);
  const lock = options.lock ?? readLock(join(root, "config", "desktop-runtime", "macos", "exiftool.lock.json"));
  validateLock(lock);
  if (cacheReady(toolRoot, perlPath, lock)) return { status: "cached", exifToolPath: executable };

  const parent = dirname(toolRoot);
  mkdirSync(parent, { recursive: true });
  const stagingRoot = mkdtempSync(join(parent, ".exiftool-stage-"));
  const archive = join(stagingRoot, `Image-ExifTool-${lock.version}.tar.gz`);
  const stagedToolRoot = join(stagingRoot, "tool");
  mkdirSync(stagedToolRoot);
  try {
    await (options.downloadArchive ?? downloadArchive)(lock.archive_url, archive);
    const actualHash = sha256File(archive);
    if (actualHash !== lock.archive_sha256) {
      throw new Error(`Mac ExifTool SHA-256 mismatch: expected ${lock.archive_sha256}, received ${actualHash}`);
    }
    (options.extractArchive ?? extractArchive)(archive, stagedToolRoot, lock);
    if (!layoutExists(stagedToolRoot)) {
      throw new Error("The Mac ExifTool archive is missing exiftool or lib/Image/ExifTool.pm");
    }
    chmodSync(join(stagedToolRoot, "exiftool"), 0o755);
    const version = installedVersion(stagedToolRoot, perlPath);
    if (version !== lock.version) {
      throw new Error(`Mac ExifTool version mismatch: expected ${lock.version}, received ${version || "empty output"}`);
    }
    writeFileSync(join(stagedToolRoot, markerName), `${JSON.stringify(expectedMarker(lock), null, 2)}\n`, "utf8");

    if (cacheReady(toolRoot, perlPath, lock)) {
      return { status: "cached", exifToolPath: executable };
    }
    rmSync(toolRoot, { recursive: true, force: true });
    renameSync(stagedToolRoot, toolRoot);
    return { status: "prepared", exifToolPath: executable };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await prepareMacExifTool();
  if (result.status === "prepared") console.log(`Prepared Mac ExifTool ${readLock(lockPath).version}: ${result.exifToolPath}`);
  if (result.status === "cached") console.log(`Mac ExifTool cache is ready: ${result.exifToolPath}`);
}
