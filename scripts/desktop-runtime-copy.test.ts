import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const windowsTest = process.platform === "win32" ? test : test.skip;
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

function copy(source: string, destination: string) {
  // Load only the production helpers; do not run downloads or alter a real runtime.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:RepositoryRoot = ${quoted(resolve(import.meta.dir, ".."))}
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quoted(join(import.meta.dir, "prepare-desktop-runtime.ps1"))}, [ref]$null, [ref]$null)
$names = @('Format-LxeNativeArgument', 'Invoke-LxeNative', 'Copy-LxeDirectoryContents')
$functions = @($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names}, $false))
if ($functions.Count -ne 3) { throw 'Expected exactly three production copy helpers' }
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
Copy-LxeDirectoryContents -Source ${quoted(source)} -Destination ${quoted(destination)}
`;
  return spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
}

function root() {
  const path = mkdtempSync(join(tmpdir(), "lxe-copy-中文 space-"));
  roots.push(path);
  return path;
}

windowsTest("runtime copy preserves long Unicode paths, empty directories and existing destination files", () => {
  const base = root(), source = join(base, "source"), destination = join(base, "destination");
  const relative = join(...Array.from({ length: 7 }, (_, index) => `nested-${index}-${"x".repeat(35)}`));
  const file = join(relative, "中文 dependency.txt");
  expect(join(destination, file).length).toBeGreaterThan(300);
  mkdirSync(join(source, relative), { recursive: true });
  mkdirSync(join(source, "empty"));
  mkdirSync(destination);
  writeFileSync(join(source, file), "runtime payload");
  writeFileSync(join(destination, "keep.txt"), "unrelated");
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = copy(source, destination);
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(readFileSync(join(destination, file), "utf8")).toBe("runtime payload");
    expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("unrelated");
    expect(statSync(join(destination, "empty")).isDirectory()).toBe(true);
  }
});

windowsTest("runtime copy preserves native copy failures and rejects a missing source", () => {
  const base = root(), source = join(base, "source"), destination = join(base, "destination");
  mkdirSync(join(source, "blocked"), { recursive: true });
  mkdirSync(destination);
  writeFileSync(join(source, "blocked", "payload.txt"), "runtime payload");
  writeFileSync(join(destination, "blocked"), "existing file");
  const failed = copy(source, destination);
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toMatch(/Copy runtime directory failed with exit code (8|9|1[0-6])/u);
  expect(failed.stderr).toContain("blocked");
  const missing = copy(join(base, "missing"), destination);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("Directory to copy is missing");
});
