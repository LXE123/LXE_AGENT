import { afterEach, expect, test } from "bun:test";
import { copyFile } from "node:fs/promises";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireDataRootLock, dataRootInitialized, initializeDataRoot, legacyDataSources, type DataMigrationPorts } from "../src/main/data/data-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lxe-data-migration-"))); roots.push(root);
  const source = join(root, "旧目录 with space", "var"), target = join(root, "用户数据");
  mkdirSync(join(source, "config"), {recursive: true});
  mkdirSync(join(source, "workspace", "empty"), {recursive: true});
  writeFileSync(join(source, "config", "settings.json"), JSON.stringify({workspace_root: join(source, "workspace"), output_directories: {inside: join(source, "output"), outside: join(root, "external")}}));
  writeFileSync(join(source, "workspace", "中文.txt"), "important bytes");
  writeFileSync(join(source, "config", "secrets.bin"), "opaque encrypted bytes");
  const ports: DataMigrationPorts = {assertIdle: async () => {}, migrateOwnedState: async () => {}, validateCredentials: async copy => {expect(readFileSync(join(copy, "config/secrets.bin"), "utf8")).toBe("opaque encrypted bytes");}};
  return {root, source, target, ports};
};

test("migration preserves source, moves internal paths and publishes only a complete copy", async () => {
  const {source,target,ports,root} = fixture();
  const original = readFileSync(join(source, "config/settings.json"));
  mkdirSync(join(source, "tmp")); writeFileSync(join(source, "tmp", "stale"), "temporary");
  await initializeDataRoot(target, source, ports);
  expect(dataRootInitialized(target)).toBe(true);
  expect(readFileSync(join(source, "config/settings.json"))).toEqual(original);
  expect(JSON.parse(readFileSync(join(target, "config/settings.json"), "utf8"))).toEqual({workspace_root: join(target, "workspace"), output_directories: {inside: join(target, "output"), outside: join(root, "external")}});
  expect(existsSync(join(target, "workspace", "empty"))).toBe(true);
  expect(existsSync(join(target, "tmp"))).toBe(false);
  rmSync(source, {recursive: true});
  expect(readFileSync(join(target, "workspace", "中文.txt"), "utf8")).toBe("important bytes");
  await initializeDataRoot(target, source, {...ports, assertIdle: async () => {throw new Error("must not import twice");}});
});

for (const failure of ["ENOSPC: no space left", "old process is running", "database integrity_check failed", "credentials cannot decrypt"]) test(`failed migration remains unpublished and can retry: ${failure}`, async () => {
  const {source,target,ports,root} = fixture();
  const failing = {...ports};
  if (failure.startsWith("ENOSPC")) failing.copyFile = async () => {throw new Error(failure);};
  else if (failure.startsWith("old")) failing.assertIdle = async () => {throw new Error(failure);};
  else if (failure.startsWith("database")) failing.migrateOwnedState = async () => {throw new Error(failure);};
  else failing.validateCredentials = async () => {throw new Error(failure);};
  await expect(initializeDataRoot(target, source, failing)).rejects.toThrow(failure);
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(root).some(name => name.includes(".migrating-"))).toBe(true);
  expect(readFileSync(`${target}.migration-error.json`, "utf8")).toContain(failure);
  await initializeDataRoot(target, source, ports);
  expect(dataRootInitialized(target)).toBe(true);
});

test("changes to the source during copy prevent publication", async () => {
  const {source,target,ports} = fixture();
  await expect(initializeDataRoot(target, source, {...ports, copyFile: async (from, to) => {
    await copyFile(from, to);
    writeFileSync(join(source, "arrived-during-copy"), "new data");
  }})).rejects.toThrow("Source data changed");
  expect(existsSync(target)).toBe(false);
});

test("never overwrites unrelated destination data or follows links", async () => {
  const {source,target,ports,root} = fixture();
  mkdirSync(target); writeFileSync(join(target, "precious"), "keep");
  await expect(initializeDataRoot(target, source, ports)).rejects.toThrow("not empty");
  rmSync(target, {recursive: true});
  const external = join(root, "external"); mkdirSync(external);
  symlinkSync(external, join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
  await expect(initializeDataRoot(target, source, ports)).rejects.toThrow("refuses links");
  expect(existsSync(external)).toBe(true);
});

test("startup lock excludes another launch and is released explicitly", () => {
  const {target} = fixture();
  const release = acquireDataRootLock(target);
  expect(() => acquireDataRootLock(target)).toThrow("in use by PID");
  expect(existsSync(target)).toBe(false);
  release();
  acquireDataRootLock(target)();
});

test("an interrupted migration can reclaim a completed dead owner's lock", async () => {
  const {target} = fixture();
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {stdout: "ignore", stderr: "ignore"});
  expect(await child.exited).toBe(0);
  writeFileSync(`${target}.startup-lock`, JSON.stringify({pid: child.pid}));
  acquireDataRootLock(target)();
  expect(existsSync(`${target}.startup-lock`)).toBe(false);
});

test("UTF-16 installer hints discover multiple sources without mixing application identities", () => {
  const {root,source} = fixture();
  const install = join(root, "new installation"); mkdirSync(join(install,"var"), {recursive: true});
  writeFileSync(join(install,"var","example"), "data");
  writeFileSync(join(install,"lxe-legacy-data.ini"), '\uFEFF[LXE]\r\nappId=test.id\r\nprevious='+join(source,"..")+'\r\nperUser='+join(source,"..")+'\r\n', "utf16le");
  expect(legacyDataSources(install, "test.id")).toEqual([join(install,"var"), source]);
  expect(() => legacyDataSources(install, "wrong.id")).toThrow("another application");
});

test.skipIf(process.platform !== "win32")("a Windows sharing violation preserves the source and permits migration after release", async () => {
  const {source,target,ports}=fixture(),file=join(source,"workspace/中文.txt");
  const script=`$ErrorActionPreference='Stop'; $handle=[IO.File]::Open('${file.replaceAll("'","''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try {[Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null} finally {$handle.Dispose()}`;
  const child=Bun.spawn(["powershell.exe","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  try {
    const reader=child.stdout.getReader();
    const first=await reader.read();reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    await expect(initializeDataRoot(target,source,ports)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  } finally {child.stdin.write("release\n");child.stdin.end();await child.exited;}
  expect(readFileSync(file,"utf8")).toBe("important bytes");
  await initializeDataRoot(target,source,ports);
  expect(dataRootInitialized(target)).toBe(true);
},20000);
