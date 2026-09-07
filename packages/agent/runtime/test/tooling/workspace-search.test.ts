import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  managedRipgrepPath,
  resolveRipgrepExecutable,
  WorkspaceSearchService,
  type WorkspaceGrepRequest,
} from "../../src/tooling/workspace-search";

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
    expect(args).toContain("--max-columns\n500");
    expect(args).not.toContain("--max-columns-preview");
    expect(args).not.toContain("--fixed-strings");
    const literalPattern = String.raw`-items[0].$HOME\n`;
    await new WorkspaceSearchService(root, { ripgrepPath: fake }).grep({
      pattern: literalPattern, literal: true, multiline: true, caseInsensitive: true,
      searchPath: join(root, "src"), outputMode: "content", context: 2, beforeContext: 0, afterContext: 0, limit: 20,
    });
    const literalArgs = readFileSync(argsPath, "utf8");
    expect(literalArgs).toContain("--fixed-strings");
    expect(literalArgs).toContain(`--regexp\n${literalPattern}\n--\n`);
    expect(literalArgs).toContain("--ignore-case");
    expect(literalArgs).toContain("--multiline\n--multiline-dotall");
    expect(literalArgs).toContain("-C\n2\n-B\n0\n-A\n0");
  });

  test("keeps external ripgrep results absolute and reusable", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "lxe-rg-absolute-"));
    roots.push(root);
    const source = join(root, "skills");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "needle\n");
    const fake = join(root, "fake-rg");
    const argsPath = join(root, "rg-args.txt");
    writeFileSync(fake, `#!/usr/bin/env bun
const args = process.argv.slice(2);
await Bun.write(${JSON.stringify(argsPath)}, args.join("\\n"));
process.stdout.write(args.at(-1) + "/SKILL.md:1:needle\\n");
`);
    chmodSync(fake, 0o755);

    const output = await new WorkspaceSearchService(root, {
      ripgrepPath: fake,
      absolutePaths: true,
    }).grep({
      pattern: "needle",
      searchPath: source,
      outputMode: "content",
      limit: 20,
    });
    expect(output.replaceAll("\\", "/")).toBe(`${source.replaceAll("\\", "/")}/SKILL.md:1:needle`);
    const args = readFileSync(argsPath, "utf8");
    expect(args).toContain("--path-separator\n/");
    expect(args).toContain(source);
  });

  test("stops ripgrep early at head_limit and reports more matches", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "lxe-rg-early-"));
    roots.push(root);
    const fake = join(root, "fake-rg");
    const completed = join(root, "rg-completed");
    writeFileSync(fake, `#!/usr/bin/env bun
import { once } from "node:events";
for (let index = 1; index <= 1_000_000; index += 1) {
  if (!process.stdout.write(\`src/a.ts:\${index}:hit\\n\`)) await once(process.stdout, "drain");
}
await Bun.write(${JSON.stringify(completed)}, "completed");
`);
    chmodSync(fake, 0o755);
    const output = await new WorkspaceSearchService(root, { ripgrepPath: fake }).grep({
      pattern: "hit",
      searchPath: root,
      outputMode: "content",
      limit: 3,
    });
    const lines = output.split("\n");
    expect(lines.slice(0, 3)).toEqual(["src/a.ts:1:hit", "src/a.ts:2:hit", "src/a.ts:3:hit"]);
    expect(lines.at(-1)).toContain("更多匹配未显示");
    expect(output).not.toContain("src/a.ts:100:hit");
    expect(existsSync(completed)).toBe(false);
  });

  test("caps retained ripgrep output by UTF-8 bytes", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "lxe-rg-budget-"));
    roots.push(root);
    const fake = join(root, "fake-rg");
    writeFileSync(fake, `#!/usr/bin/env bun
import { once } from "node:events";
const line = "f:1:" + "中文🙂".repeat(200) + "\\n";
for (let index = 0; index < 100_000; index += 1) {
  if (!process.stdout.write(line)) await once(process.stdout, "drain");
}
`);
    chmodSync(fake, 0o755);
    const output = await new WorkspaceSearchService(root, { ripgrepPath: fake }).grep({
      pattern: "x",
      searchPath: root,
      outputMode: "content",
      limit: 1_000_000,
    });
    expect(output).toContain("安全上限");
    const retained = output.split("\n").slice(0, -1).join("\n");
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(1_024 * 1_024);
  });

  test("reports a final-line overflow and a giant unterminated line as byte-budget stops", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "lxe-rg-last-line-"));
    roots.push(root);
    const finalOverflow = join(root, "fake-rg-final");
    writeFileSync(finalOverflow, `#!/usr/bin/env bun
process.stdout.write("a".repeat(1_048_570) + "\\n");
process.stdout.write("overflow\\n");
`);
    chmodSync(finalOverflow, 0o755);
    const finalOutput = await new WorkspaceSearchService(root, { ripgrepPath: finalOverflow }).grep({
      pattern: "x", searchPath: root, outputMode: "content", limit: 1_000_000,
    });
    expect(finalOutput).toContain("安全上限");
    expect(finalOutput).not.toContain("overflow");

    const unterminated = join(root, "fake-rg-unterminated");
    writeFileSync(unterminated, `#!/usr/bin/env bun
process.stdout.write("中".repeat(400_000));
`);
    chmodSync(unterminated, 0o755);
    const unterminatedOutput = await new WorkspaceSearchService(root, { ripgrepPath: unterminated }).grep({
      pattern: "x", searchPath: root, outputMode: "content", limit: 1_000_000,
    });
    expect(unterminatedOutput).toContain("单行输出超过");
    expect(unterminatedOutput).not.toBe("No matches found.");
  });

  test("drains stderr after retaining its first 64 KiB", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "lxe-rg-stderr-"));
    roots.push(root);
    const fake = join(root, "fake-rg");
    writeFileSync(fake, `#!/usr/bin/env bun
process.stderr.write("e".repeat(256 * 1024));
process.stdout.write("src/a.ts:1:hit\\n");
`);
    chmodSync(fake, 0o755);
    const output = await new WorkspaceSearchService(root, { ripgrepPath: fake }).grep({
      pattern: "hit", searchPath: root, outputMode: "content", limit: 20,
    });
    expect(output).toBe("src/a.ts:1:hit");
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

const realRipgrep = resolveRipgrepExecutable();
for (const backend of ["fallback", "real rg"] as const) {
  describe(`literal grep (${backend})`, () => {
    const backendTest = test.skipIf(backend === "real rg" && !realRipgrep);
    function fixture(source: string) {
      const root = mkdtempSync(join(tmpdir(), "lxe-literal-"));
      roots.push(root);
      writeFileSync(join(root, "sample.txt"), source);
      const service = new WorkspaceSearchService(root, { ripgrepPath: backend === "fallback" ? null : realRipgrep! });
      const search = (options: Partial<WorkspaceGrepRequest> & { pattern: string }) => service.grep({
        searchPath: root, outputMode: "content", limit: 100, ...options,
      });
      return { root, search };
    }
    backendTest("distinguishes literal text from regex and preserves backend regex errors", async () => {
      const { search } = fixture("foo.bar\nfooXbar\nitems[0]\nitems0\n[\n");
      expect(await search({ pattern: "foo.bar", literal: true })).toBe("sample.txt:1:foo.bar");
      expect(await search({ pattern: "foo.bar" })).toContain("sample.txt:2:fooXbar");
      expect(await search({ pattern: "items[0]", literal: true })).toBe("sample.txt:3:items[0]");
      expect(await search({ pattern: "items[0]", literal: false })).toBe("sample.txt:4:items0");
      expect(await search({ pattern: "[", literal: true })).toContain("sample.txt:5:[");
      await expect(search({ pattern: "[" })).rejects.toThrow();
    });
    backendTest("treats metacharacters, backslash-n and Unicode punctuation as text", async () => {
      const pattern = String.raw`-a/b\c.$^*+?()[]{}| 中文—🙂\n`;
      const { search } = fixture(`${pattern}\nnot a match\n`);
      expect(await search({ pattern, literal: true })).toBe(`sample.txt:1:${pattern}`);
      expect(await search({ pattern: "中文-", literal: true })).toBe("No matches found.");
    });
    backendTest("supports case folding, all modes and explicit zero context overrides", async () => {
      const { search } = fixture("before\nITEMS[0]\nafter\nitems[0]\nlast\n");
      const options = { pattern: "items[0]", literal: true, caseInsensitive: true };
      expect(await search({ ...options, outputMode: "files_with_matches", context: 2 })).toBe("sample.txt");
      expect(await search({ ...options, outputMode: "count", context: 2 })).toBe("sample.txt:2");
      expect(await search({ ...options, context: 2, beforeContext: 0, afterContext: 0 })).toBe("sample.txt:2:ITEMS[0]\nsample.txt:4:items[0]");
      const after = await search({ ...options, context: 1, beforeContext: 0 });
      expect(after).not.toContain("before");
      expect(after).toContain("sample.txt-3-after");
      expect(after).toContain("sample.txt-5-last");
      const before = await search({ ...options, context: 1, afterContext: 0 });
      expect(before).toContain("sample.txt-1-before");
      expect(before).not.toContain("last");
    });
    backendTest("matches literal LF only with multiline and retains backend formatting", async () => {
      const { search } = fixture("a[0]\nb.*\na0\nbZZ\n");
      const options = { pattern: "a[0]\nb.*", literal: true };
      await expect(search(options)).rejects.toThrow("multiline=true");
      const output = await search({ ...options, multiline: true });
      expect(output).toContain("sample.txt:1:a[0]");
      expect(output).not.toContain("a0");
      if (backend === "real rg") expect(output).toContain("sample.txt:2:b.*");
      else expect(output).toBe("sample.txt:1:a[0]");
      expect(await search({ ...options, multiline: true, outputMode: "files_with_matches" })).toBe("sample.txt");
      expect(await search({ ...options, multiline: true, outputMode: "count" })).toBe("sample.txt:1");
    });
    backendTest("honors cancellation before starting either backend", async () => {
      const { search } = fixture("x");
      const controller = new AbortController();
      controller.abort(new Error("literal search cancelled"));
      await expect(search({ pattern: "x", literal: true, signal: controller.signal })).rejects.toThrow("literal search cancelled");
    });
  });
}
