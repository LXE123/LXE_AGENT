import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  managedRipgrepPath,
  resolveRipgrepExecutable,
  WorkspaceSearchService,
} from "../src/workspace-search";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceSearchService", () => {
  test("prefers the managed Windows sidecar before PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "lxe-rg-home-"));
    roots.push(home);
    const managed = managedRipgrepPath(home, "win32")!;
    mkdirSync(dirname(managed), { recursive: true });
    writeFileSync(managed, "fixture");
    expect(resolveRipgrepExecutable({
      homeDirectory: home,
      platform: "win32",
      which: () => "C:\\path\\rg.exe",
    })).toBe(managed);
  });

  test("uses the configured ripgrep executable and preserves main arguments", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "lxe-rg-fast-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "needle\n");
    const fake = join(root, "fake-rg");
    const argsPath = join(root, "rg-args.txt");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\nprintf 'src/a.ts:1:needle\\n'\n`);
    chmodSync(fake, 0o755);
    const output = await new WorkspaceSearchService(root, { ripgrepPath: fake }).grep({
      pattern: "needle",
      searchPath: join(root, "src"),
      outputMode: "content",
      fileType: "ts",
      beforeContext: 1,
      limit: 20,
    });
    expect(output).toBe("src/a.ts:1:needle");
    const args = readFileSync(argsPath, "utf8");
    expect(args).toContain("--no-config");
    expect(args).toContain("--type\nts");
    expect(args).toContain("-B\n1");
    expect(args).toContain("--regexp\nneedle");
  });

  test("keeps fallback grep/find asynchronous and skips binary content", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-search-fallback-"));
    roots.push(root);
    const source = join(root, "src");
    mkdirSync(source, { recursive: true });
    for (let index = 0; index < 160; index += 1) {
      writeFileSync(join(source, `file-${String(index).padStart(3, "0")}.txt`), index === 159 ? "needle\n" : "plain\n");
    }
    writeFileSync(join(source, "binary.unknown"), new Uint8Array([110, 101, 0, 101, 100, 108, 101]));
    const service = new WorkspaceSearchService(root, { ripgrepPath: null });
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    const grep = await service.grep({
      pattern: "needle",
      searchPath: source,
      outputMode: "files_with_matches",
      fileType: "txt",
      limit: 20,
    });
    expect(timerRan).toBe(true);
    expect(grep).toContain("src/file-159.txt");
    expect(grep).not.toContain("binary.unknown");
    const found = await service.find({ pattern: "file-*.txt", searchPath: source, limit: 2 });
    expect(found).toContain("src/file-");
    expect(found).toContain("showing first 2 of 160");
  });
});
