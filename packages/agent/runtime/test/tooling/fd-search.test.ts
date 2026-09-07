import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFdVersion, escapeFindPath, fdArguments, findWithFd, resolveFdExecutable, validateFindInput, windowsFdGlob } from "../../src/tooling/fd-search";

const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "lxe-fd-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const file = (root: string, path: string, value = "") => { const full = join(root, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, value); return full; };

const invalid = [null, [], "x", {}, { pattern: "" }, { pattern: null }, { pattern: 1 },
  ...["", " \t", null, 1].map(path => ({ pattern: "*", path })),
  ...[null, "10", false, 0, -1, 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined].map(limit => ({ pattern: "*", limit })),
  { pattern: "*", head_limit: 1 }, { pattern: "*", offset: 1 }, { pattern: "*", no_ignore: true }];
describe("find input", () => {
  test.each(invalid.map(value => [value]))("rejects invalid arguments %#", value => expect(() => validateFindInput(value)).toThrow());
  test("defaults, whitespace, limits, and explicit migration error", () => {
    expect(validateFindInput({ pattern: " " })).toEqual({ pattern: " ", path: ".", limit: 1000 });
    expect(validateFindInput({ pattern: "*", path: " dir ", limit: Number.MAX_SAFE_INTEGER }).path).toBe(" dir ");
    expect(() => validateFindInput({ pattern: "*", head_limit: 20 })).toThrow('"limit":1000');
  });
  test("builds PI style glob arguments with unmodified option-like input", () => {
    const args = fdArguments({ pattern: "src/**/*.ts", searchPath: "C:\\repo", limit: 10 }, false, "win32");
    expect(args).toContain("--no-require-git");
    expect(args).toContain("--print0");
    expect(args).toContain("--show-errors");
    expect(args).not.toContain("--type");
    expect(args.at(-2)).toBe(String.raw`{src[/\\]*.ts,src[/\\]**[/\\]*.ts,**[/\\]src[/\\]*.ts,**[/\\]src[/\\]**[/\\]*.ts}`);
    expect(windowsFdGlob("**/src/**/*.{ts,tsx}")).not.toContain("{{");
    expect(() => windowsFdGlob("**/".repeat(9) + "*.ts")).toThrow("256");
    expect(fdArguments({ pattern: "-name", searchPath: "/repo", limit: 1 }, true).slice(-3)).toEqual(["--", "-name", "/repo"]);
  });
  test("escapes display without trimming or losing backslashes", () => {
    expect(escapeFindPath(" a\\b\n\t\r\u0001\u202e ")).toBe(" a\\\\b\\n\\t\\r\\u0001\\u202e ");
  });
});

describe("real pinned fd", () => {
  // This suite deliberately fails if fd has not been prepared; it must exercise a real binary.
  test("requires pinned fd, preserves missing executable and version errors", () => {
    checkFdVersion(resolveFdExecutable());
    expect(() => resolveFdExecutable(null)).toThrow("unavailable");
    expect(() => checkFdVersion(join(temporary(), "missing-fd"))).toThrow();
    expect(() => checkFdVersion(process.execPath)).toThrow("version mismatch");
  });
  test("glob zero-directory matching, braces, classes and smart case", async () => {
    const root = temporary();
    for (const name of ["app.ts", "src/a.ts", "src/nested/b.ts", "src/c.tsx", "src/Foo.ts", "中文 space.ts"]) file(root, name);
    const search = (pattern: string) => findWithFd(root, { pattern, searchPath: root, limit: 100 });
    const all = (await search("**/*.ts")).split("\n");
    expect(all).toContain("app.ts"); expect(all).toContain("src/a.ts");
    expect((await search("src/**/*.ts")).split("\n")).toContain("src/a.ts");
    expect((await search("*.{ts,tsx}")).split("\n")).toContain("src/c.tsx");
    expect((await search("src/**/*.{ts,tsx}")).split("\n")).toContain("src/c.tsx");
    expect(await search("[ab].ts")).toContain("src/nested/b.ts");
    expect(await search("foo.ts")).toBe("src/Foo.ts");
    expect(await search("FOO.ts")).toBe("No entries found.");
    expect(await search("中文*.ts")).toBe("中文 space.ts");
  });
  test("includes hidden entries and directories, respects ignore files outside Git", async () => {
    const root = temporary();
    file(root, ".gitignore", "ignored.txt\n"); file(root, "ignored.txt"); file(root, ".hidden"); file(root, "build/source.txt");
    const output = await findWithFd(root, { pattern: "*", searchPath: root, limit: 100 });
    expect(output.split("\n")).toContain("build");
    expect(output).toContain("build/source.txt"); expect(output).toContain(".hidden"); expect(output).not.toContain("ignored.txt");
  });
  test("respects parent ignore rules but stops at nested Git repositories", async () => {
    const root = temporary();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    file(root, ".gitignore", "*.txt\n"); file(root, "child/ignored.txt"); file(root, "child/keep.ts");
    const nested = join(root, "nested"); mkdirSync(nested);
    expect(Bun.spawnSync(["git", "init", "-q", nested]).exitCode).toBe(0);
    file(root, "nested/kept.txt");
    expect(await findWithFd(root, { pattern: "*.txt", searchPath: join(root, "child"), limit: 100 })).toBe("No entries found.");
    expect(await findWithFd(root, { pattern: "*.txt", searchPath: nested, limit: 100 })).toBe("nested/kept.txt");
  });
  test("returns directory links without traversing them", async () => {
    const root = temporary(); const external = temporary(); file(external, "unseen.txt");
    symlinkSync(external, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const output = await findWithFd(root, { pattern: "*", searchPath: root, limit: 100 });
    expect(output).toBe("link");
  });
  test.skipIf(process.platform === "win32")("preserves whitespace, newlines and literal backslashes in names", async () => {
    const root = temporary(); file(root, " a\n\\b ");
    expect(await findWithFd(root, { pattern: "*", searchPath: root, limit: 100 })).toBe(" a\\n\\\\b ");
  });
  test("applies limits and keeps external results absolute", async () => {
    const root = temporary(); for (let i = 0; i < 50; i++) file(root, `file${i}.txt`);
    const output = await findWithFd(root, { pattern: "*.txt", searchPath: root, limit: 2 });
    expect(output.split("\n")).toHaveLength(3); expect(output).toContain("Result limit (2)");
    const external = await findWithFd(root, { pattern: "file0.txt", searchPath: root, limit: 100 }, { absolutePaths: true });
    expect(external).toBe(join(root, "file0.txt").replaceAll("\\", "/"));
    await expect(findWithFd(root, { pattern: "*", searchPath: join(root, "file0.txt"), limit: 1 })).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(findWithFd(root, { pattern: "*", searchPath: join(root, "missing"), limit: 1 })).rejects.toMatchObject({ code: "ENOENT" });
  });
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports filesystem permission errors", async () => {
    const root = temporary(); const denied = join(root, "denied"); mkdirSync(denied); file(root, "visible"); chmodSync(denied, 0);
    try { expect(await findWithFd(root, { pattern: "*", searchPath: root, limit: 100 })).toContain("Permission denied"); }
    finally { chmodSync(denied, 0o755); }
  });
});

function fakeFd(root: string, body: string) {
  const path = join(root, "fake-fd");
  writeFileSync(path, `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("fd 10.5.0"); process.exit(0); }\n${body}`);
  chmodSync(path, 0o755); return path;
}
describe.skipIf(process.platform === "win32")("fd process boundaries", () => {
  test("parses NUL and UTF-8 across chunks, preserves process order", async () => {
    const root = temporary();
    const fdPath = fakeFd(root, 'const b=Buffer.from("z\\0中文\\0a\\0"); for (const v of b) { process.stdout.write(Buffer.from([v])); await Bun.sleep(2); }');
    expect(await findWithFd(root, { pattern: "*", searchPath: root, limit: 100 }, { fdPath })).toBe("z\n中文\na");
  });
  test("stops producers at count and character budgets with complete paths", async () => {
    const root = temporary();
    const fdPath = fakeFd(root, 'for(let i=0;i<10000;i++){process.stdout.write("x".repeat(200)+i+"\\0"); await Bun.sleep(1);} await Bun.write("completed", "yes");');
    const limited = await findWithFd(root, { pattern: "*", searchPath: root, limit: 2 }, { fdPath });
    expect(limited.split("\n")).toHaveLength(3); expect(existsSync(join(root, "completed"))).toBe(false);
    const output = await findWithFd(root, { pattern: "*", searchPath: root, limit: 10000 }, { fdPath });
    expect(output.length).toBeLessThanOrEqual(10000); expect(output).toContain("Output character limit");
    expect(output.split("\n").slice(0, -1).every(line => /^x+\d+$/.test(line))).toBe(true);
  });
  test("keeps actual errors and marks partial results, bounds diagnostic output", async () => {
    const root = temporary();
    let fdPath = fakeFd(root, 'process.stderr.write("actual failure"); process.exit(2);');
    await expect(findWithFd(root, { pattern: "*", searchPath: root, limit: 100 }, { fdPath })).rejects.toThrow("actual failure");
    fdPath = fakeFd(root, 'process.stdout.write("file\\0"); process.stderr.write("actual partial failure "+"e".repeat(100000)); process.exitCode=2;');
    const output = await findWithFd(root, { pattern: "*", searchPath: root, limit: 100 }, { fdPath });
    expect(output).toStartWith("file\nSearch incomplete."); expect(output).toContain("actual partial failure"); expect(output).toContain("truncated"); expect(output.length).toBeLessThanOrEqual(10000);
  });
  test("rejects oversized and unfinished records", async () => {
    const root = temporary();
    for (const [body, error] of [['process.stdout.write("x".repeat(20000)+"\\0");', "complete find path"], ['process.stdout.write("x".repeat(1100000));', "1 MiB"], ['process.stdout.write("unfinished");', "incomplete NUL"]]) {
      const fdPath = fakeFd(root, body!);
      await expect(findWithFd(root, { pattern: "*", searchPath: root, limit: 100 }, { fdPath })).rejects.toThrow(error!);
    }
  });
  test("times out and cancels running children", async () => {
    const root = temporary(); const fdPath = fakeFd(root, 'setInterval(()=>{},1000);');
    await expect(findWithFd(root, { pattern: "*", searchPath: root, limit: 100 }, { fdPath, timeoutMs: 20 })).rejects.toThrow("timed out");
    const controller = new AbortController(); const promise = findWithFd(root, { pattern: "*", searchPath: root, limit: 100, signal: controller.signal }, { fdPath });
    setTimeout(() => controller.abort(new Error("cancelled fd")), 50);
    await expect(promise).rejects.toThrow("cancelled fd");
    await expect(findWithFd(root, { pattern: "*", searchPath: root, limit: 100, signal: controller.signal }, { fdPath })).rejects.toThrow("cancelled fd");
  });
});
