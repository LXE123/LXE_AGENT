import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktopFd } from "./prepare-desktop-fd";
import { FD_VERSION } from "../packages/agent/runtime/src/tooling/fd-search";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "lxe-fd-prepare-")); roots.push(root);
  const config = join(root, "config/desktop-runtime"); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "fd.lock.json"), JSON.stringify({ version: FD_VERSION, platforms: { "darwin-arm64": {
    archive_url: "https://example.invalid/fd.tar.gz", archive_sha256: createHash("sha256").update("archive").digest("hex"),
  } } }));
  let downloads = 0;
  const options = {
    repositoryRoot: root, platform: "darwin", arch: "arm64",
    download: async (_url: string, path: string) => { downloads++; writeFileSync(path, "archive"); },
    extract: (_archive: string, destination: string) => { mkdirSync(join(destination, "release")); writeFileSync(join(destination, "release/fd"), "binary"); },
    checkVersion: (_path: string) => {},
  };
  return { root, options, downloads: () => downloads };
}
test("prepares once, detects corrupted binary and invalidates cache when lock changes", async () => {
  const { root, options, downloads } = setup();
  const first = await prepareDesktopFd(options); expect(first.status).toBe("prepared");
  expect((await prepareDesktopFd(options)).status).toBe("cached"); expect(downloads()).toBe(1);
  writeFileSync(first.path, "corrupt");
  expect((await prepareDesktopFd(options)).status).toBe("prepared"); expect(downloads()).toBe(2);
  const marker = join(root, "build/desktop-runtime/darwin-arm64/tools/.fd.json");
  const value = JSON.parse(readFileSync(marker, "utf8")); value.archive_sha256 = "stale"; writeFileSync(marker, JSON.stringify(value));
  expect((await prepareDesktopFd(options)).status).toBe("prepared"); expect(downloads()).toBe(3);
});
test("does not publish a checksum mismatch, missing binary or version failure", async () => {
  for (const kind of ["checksum", "missing", "version"]) {
    const { root, options } = setup();
    if (kind === "checksum") options.download = async (_url, path) => { writeFileSync(path, "wrong"); };
    if (kind === "missing") options.extract = () => {};
    if (kind === "version") options.checkVersion = () => { throw new Error("wrong fd version"); };
    await expect(prepareDesktopFd(options)).rejects.toThrow();
    expect(existsSync(join(root, "build/desktop-runtime/darwin-arm64/tools/fd"))).toBe(false);
  }
});
test("requires a supported target and lock/runtime agreement", async () => {
  const { root, options } = setup();
  await expect(prepareDesktopFd({ ...options, arch: "unsupported" })).rejects.toThrow("unsupported");
  const path = join(root, "config/desktop-runtime/fd.lock.json");
  const value = JSON.parse(readFileSync(path, "utf8")); value.version = "0.0.0"; writeFileSync(path, JSON.stringify(value));
  await expect(prepareDesktopFd(options)).rejects.toThrow("lock version");
});
test("Windows package wiring includes the fd descriptor, fingerprint and resource", () => {
  const root = join(import.meta.dirname, "..");
  const prep = readFileSync(join(root, "scripts/prepare-desktop-runtime.ps1"), "utf8");
  expect(prep).toContain('"config/desktop-runtime/fd.lock.json"');
  expect(prep).toContain('fd_path = Join-Path $Root "tools\\fd.exe"');
  expect(prep).toContain("fd archive checksum mismatch");
  expect(prep).toContain("$toolFiles.Count -eq 2");
  expect(prep).toContain("$fdOnly.binary_sha256 -eq (Get-LxeFileSha256 -Path $fdOnlyBinary)");
  expect(readFileSync(join(root, "scripts/prepare-desktop-resources.ts"), "utf8")).toContain('`${scopeEntry("runtime-tools").target}/fd.exe`');
  expect(readFileSync(join(root, "scripts/build-desktop-windows.ps1"), "utf8")).toContain("LXE_DESKTOP_FD_PATH");
});
