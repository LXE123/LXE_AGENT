import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  macExifToolPath,
  prepareMacExifTool,
  type MacExifToolLock,
} from "./prepare-desktop-macos-exiftool";

const temporaryRoots: string[] = [];
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-mac-exiftool-test-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const archiveBytes = Buffer.from("fixture archive");
const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
const lock = (sha256 = archiveHash): MacExifToolLock => ({
  version: "13.59",
  archive_url: "https://downloads.example.test/Image-ExifTool-13.59.tar.gz",
  archive_sha256: sha256,
  archive_root: "Image-ExifTool-13.59",
});

const createLayout = (destination: string): void => {
  mkdirSync(join(destination, "lib", "Image"), { recursive: true });
  writeFileSync(join(destination, "exiftool"), "print \"13.59\\n\";\n", "utf8");
  writeFileSync(join(destination, "lib", "Image", "ExifTool.pm"), "1;\n", "utf8");
};

const fakePerl = (root: string): string => {
  const path = join(root, "perl-fixture");
  writeFileSync(path, "fixture", "utf8");
  return path;
};

describe("Mac ExifTool preparation", () => {
  test("prepares the pinned private tool once and then reuses the cache", async () => {
    const root = temporaryRoot();
    const perlPath = fakePerl(root);
    let downloads = 0;
    let extractions = 0;
    const options = {
      platform: "darwin" as const,
      arch: "arm64",
      repositoryRoot: root,
      perlPath,
      lock: lock(),
      readInstalledVersion: () => "13.59",
      downloadArchive: async (_url: string, destination: string) => {
        downloads += 1;
        writeFileSync(destination, archiveBytes);
      },
      extractArchive: (_archive: string, destination: string) => {
        extractions += 1;
        createLayout(destination);
      },
    };

    const prepared = await prepareMacExifTool(options);
    const cached = await prepareMacExifTool(options);

    expect(prepared.status).toBe("prepared");
    expect(cached.status).toBe("cached");
    expect(prepared.exifToolPath).toBe(macExifToolPath(root, "arm64"));
    expect(downloads).toBe(1);
    expect(extractions).toBe(1);
    expect(readFileSync(prepared.exifToolPath, "utf8")).toContain("13.59");
  });

  test("stops on missing Perl, download failures, and checksum mismatches", async () => {
    const root = temporaryRoot();
    const perlPath = fakePerl(root);
    await expect(prepareMacExifTool({
      platform: "darwin",
      repositoryRoot: root,
      perlPath: join(root, "missing-perl"),
      lock: lock(),
    })).rejects.toThrow("Mac Perl runtime is unavailable");

    await expect(prepareMacExifTool({
      platform: "darwin",
      repositoryRoot: root,
      perlPath,
      lock: lock(),
      downloadArchive: async () => { throw new Error("network refused by fixture"); },
    })).rejects.toThrow("network refused by fixture");

    await expect(prepareMacExifTool({
      platform: "darwin",
      repositoryRoot: root,
      perlPath,
      lock: lock("0".repeat(64)),
      downloadArchive: async (_url, destination) => { writeFileSync(destination, archiveBytes); },
    })).rejects.toThrow("SHA-256 mismatch");
  });

  test("reports the real tar error for a corrupt archive", async () => {
    const root = temporaryRoot();
    const perlPath = fakePerl(root);
    const corruptArchive = join(root, "corrupt.tar.gz");
    writeFileSync(corruptArchive, archiveBytes);

    await expect(prepareMacExifTool({
      platform: "darwin",
      repositoryRoot: root,
      perlPath,
      lock: lock(),
      downloadArchive: async (_url, destination) => { copyFileSync(corruptArchive, destination); },
    })).rejects.toThrow("Could not extract Mac ExifTool");
  });

  test("does nothing on non-Mac platforms", async () => {
    const root = temporaryRoot();
    const result = await prepareMacExifTool({
      platform: "win32",
      repositoryRoot: root,
      arch: "x64",
    });
    expect(result.status).toBe("skipped");
  });
});
