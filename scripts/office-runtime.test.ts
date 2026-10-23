import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approvedConstructiveResourcePath } from "./desktop-resource-scope";
import { resolveDesktopPaths } from "../apps/desktop/src/main/paths";
import { execRuntimeEnvironment, resolveExecRuntimePaths } from "../apps/agent-cli/src/exec-paths";
import { SkillCatalog } from "../packages/agent/runtime/src/tooling/skills";
const { verifyOfficeRuntime } = createRequire(import.meta.url)("./office-runtime.cjs");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "office-runtime-")); temporary.push(root);
  const scope = join(root, "node_modules", "@deepseek-ai");
  const engine = join(scope, "libreoffice-kit-win32-x64");
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  write(join(scope, "libreoffice-kit", "package.json"), { version: "0.1.5", optionalDependencies: { "@deepseek-ai/libreoffice-kit-win32-x64": "0.1.5" } });
  write(join(scope, "libreoffice-kit", "lib", "cli.js"), "cli");
  write(join(engine, "package.json"), { name: "@deepseek-ai/libreoffice-kit-win32-x64", version: "0.1.5" });
  const files: Record<string, string> = {};
  for (const name of ["bin/engine.exe", "program/resource", "sources/source.json", "licenses/MIT"]) {
    write(join(engine, name), name);
    files[name] = createHash("sha256").update(name).digest("hex");
  }
  write(join(engine, "prebuilds.json"), { schemaVersion: 1, version: "0.1.5", status: "built", platform: "win32-x64",
    engine: { kind: "native", executable: "bin/engine.exe", programDirectory: "program" }, files,
    source: { files: ["sources/source.json"] }, licenses: [{ path: "licenses/MIT" }] });
  return { root, engine };
}
test("Office builds reject missing or damaged native payload and license resources", () => {
  const { root, engine } = fixture();
  expect(verifyOfficeRuntime(root, "win32-x64").verifiedFiles).toBe(4);
  writeFileSync(join(engine, "program/resource"), "damaged");
  expect(() => verifyOfficeRuntime(root, "win32-x64")).toThrow("checksum mismatch");
  writeFileSync(join(engine, "program/resource"), "program/resource");
  rmSync(join(engine, "licenses/MIT"));
  expect(() => verifyOfficeRuntime(root, "win32-x64")).toThrow();
  rmSync(engine, { recursive: true });
  expect(() => verifyOfficeRuntime(root, "win32-x64")).toThrow();
});
test("Office resources preserve upstream source, notices and fonts", () => {
  for (const path of ["sources/scripts/build-native.mjs", "licenses/LibreOffice-third-party.html", "program/fonts/font.ttf", "README.zh.md"]) {
    expect(approvedConstructiveResourcePath(`runtime/office/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/${path}`)).toBe(true);
  }
});
test("desktop Office paths follow installed resources and ignore external overrides", () => {
  const paths = resolveDesktopPaths({ packaged: true, appPath: "C:\\LXE\\resources\\app.asar", executablePath: "C:\\LXE\\LXE.exe", resourcesPath: "C:\\LXE\\resources", platform: "win32", arch: "x64",
    environment: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", LXE_OFFICE_NODE: "C:\\external\\node.exe", LXE_OFFICE_CLI: "C:\\external\\cli.js" }, pathExists: () => true });
  expect(paths.officeNodePath).toBe("C:\\LXE\\resources\\runtime\\node\\node.exe");
  expect(paths.officeCliPath).toBe("C:\\LXE\\resources\\runtime\\office\\node_modules\\@deepseek-ai\\libreoffice-kit\\lib\\cli.js");
});
test("VC++ installer requires the locked version and handles restart/failure", () => {
  const root = join(import.meta.dirname, "..");
  const lock = JSON.parse(readFileSync(join(root, "config/desktop-runtime/office/vc-redist.lock.json"), "utf8"));
  const source = readFileSync(join(root, "apps/desktop/resources/office-prerequisites.nsh"), "utf8");
  expect(source).toContain(`!define LXE_VC_REDIST_VERSION "${lock.version}"`);
  expect(source).toContain('shell32::ShellExecuteEx');
  expect(source).toContain('kernel32::GetExitCodeProcess');
  expect(source).toContain("SetRebootFlag true");
  expect(source).toContain("VC++ x64 setup failed with exit code $0");
});
test("Agent CLI provides Office paths when executing from an arbitrary task workspace", () => {
  const sourceRoot = join(import.meta.dirname, "..");
  const paths = resolveExecRuntimePaths({ environment: { LXE_SOURCE_ROOT: sourceRoot }, moduleDirectory: sourceRoot, platform: "darwin", arch: "arm64" });
  const environment = execRuntimeEnvironment(paths, join(sourceRoot, "var", "agent.sqlite3"), {});
  expect(environment.LXE_OFFICE_NODE).toBe(join(sourceRoot, "build", "desktop-runtime", "darwin-arm64", "node", "node"));
  expect(environment.LXE_OFFICE_CLI).toBe(join(sourceRoot, "build", "desktop-runtime", "darwin-arm64", "office", "node_modules", "@deepseek-ai", "libreoffice-kit", "lib", "cli.js"));
});
test("all Office skills load under the existing default permission without business commands", () => {
  const userRoot = mkdtempSync(join(tmpdir(), "office-user-skills-")); temporary.push(userRoot);
  const catalog = new SkillCatalog(join(import.meta.dirname, ".."), userRoot, { sharedSkillsRoot: false });
  catalog.forceRefresh();
  const available = catalog.list({ allowedTypes: new Set(["default"]) });
  const office = available.filter(skill => skill.name.startsWith("office-"));
  expect(office.map(skill => skill.name).sort()).toEqual(["office-docx", "office-pptx", "office-xlsx"]);
  for (const skill of office) expect(skill.commands).toEqual([]);
});
