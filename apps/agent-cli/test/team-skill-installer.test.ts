import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { type TeamInstallTicket } from "@lxe/desktop-protocol/team-skills";
import { SkillCatalog } from "@lxe/runtime";
import { TeamSkillInstaller } from "../src/team-skill-installer";
import { downloadTeamSkill, readTeamZip } from "../src/team-skill-download";

const temp: string[] = [];
afterEach(() => { for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const id = randomUUID();
const storageUrl = "https://dataloom-rdqueaxi.feishucdn.com/4577945282/bucket_aadk3bkqatkfw/demo.zip?sign=fixture";
function ticket(version: string): TeamInstallTicket {
  return { skillId: id, version, size: 3, sha256: createHash("sha256").update("ZIP").digest("hex"),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), downloadUrl: storageUrl };
}
const manifest = (version?: string, name = "demo") => `---
name: ${name}
description: A team skill
${version ? `metadata:
  team-skills-id: "${id}"
  team-skills-version: "${version}"
` : ""}---
Run demo.
`;

async function archive(version?: string, extra = "assets/example.txt", name = "demo") {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add(name + "/SKILL.md", new TextReader(manifest(version, name)));
  await writer.add(name + "/" + extra, new TextReader(version ?? "legacy"));
  return Buffer.from(await writer.close());
}

function setup(download: (id: string, version: string) => Promise<Buffer>) {
  const root = mkdtempSync(join(tmpdir(), "lxe-team-installer-")); temp.push(root);
  mkdirSync(join(root, "repo"));
  const skills = join(root, "user");
  const catalog = new SkillCatalog(root, skills, { repositorySkillsRoot: join(root, "repo"), sharedSkillsRoot: join(root, "shared") });
  return { root, skills, catalog, installer: new TeamSkillInstaller(catalog, t => download(t.skillId, t.version)) };
}

test("legacy install, confirmed update and rediscovery after restart", async () => {
  const { root, skills, catalog, installer } = setup((_, version) => archive(version === "1.0.0" ? undefined : version));
  expect(await installer.versions([id])).toEqual({});
  expect(await installer.install(ticket("1.0.0"))).toEqual({ kind: "installed", version: "1.0.0" });
  expect(await installer.versions([id])).toEqual({ [id]: "1.0.0" });
  const target = join(skills, "demo");
  expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(manifest());
  writeFileSync(join(target, "notes.txt"), "keep me");
  const prompt = await installer.install(ticket("1.0.1"));
  if (prompt.kind !== "confirm") throw new Error("Expected replacement prompt");
  writeFileSync(join(target, "personal.txt"), "local edit");
  const changed = await installer.install(ticket("1.0.1"), prompt.fingerprint);
  if (changed.kind !== "confirm") throw new Error("Stale confirmation replaced a local edit");
  expect(readFileSync(join(target, "personal.txt"), "utf8")).toBe("local edit");
  expect(await installer.install(ticket("1.0.1"), changed.fingerprint)).toEqual({ kind: "installed", version: "1.0.1" });
  expect(readFileSync(join(target, "assets/example.txt"), "utf8")).toBe("1.0.1");
  expect(catalog.get("demo")?.teamRelease?.version).toBe("1.0.1");
  expect(await installer.install(ticket("1.0.2"))).toEqual({ kind: "installed", version: "1.0.2" });
  const restarted = new TeamSkillInstaller(new SkillCatalog(root, skills, { repositorySkillsRoot: join(root, "repo"), sharedSkillsRoot: false }));
  expect(await restarted.versions([id])).toEqual({ [id]: "1.0.2" });
  await expect(installer.install(ticket("1.0.0"))).rejects.toThrow("本机版本较新");
});

test.each(["install", "update"])("a shared namesake present before %s yields to the user release", async phase => {
  const { root, catalog, installer } = setup((_, version) => archive(version));
  if (phase === "update") await installer.install(ticket("1.0.0"));
  const shared = join(root, "shared", "demo");
  mkdirSync(shared, { recursive: true });
  const sharedManifest = manifest("9.9.9");
  writeFileSync(join(shared, "SKILL.md"), sharedManifest);

  expect(await installer.versions([id])).toEqual(phase === "install" ? {} : { [id]: "1.0.0" });
  expect(await installer.install(ticket("1.0.1"))).toEqual({ kind: "installed", version: "1.0.1" });
  expect(await installer.versions([id])).toEqual({ [id]: "1.0.1" });
  expect(catalog.get("demo")).toMatchObject({ source: "user", teamRelease: { id, version: "1.0.1" } });
  expect(readFileSync(join(shared, "SKILL.md"), "utf8")).toBe(sharedManifest);
});

test.each(["repo", "user"])("a different %s directory with the same skill name blocks installation", async source => {
  const { root, skills, installer } = setup((_, version) => archive(version));
  const other = join(root, source, "other-folder");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "SKILL.md"), manifest());
  await expect(installer.install(ticket("1.0.0"))).rejects.toThrow("同名 Skill");
  expect(existsSync(join(skills, "demo"))).toBe(false);
});

test("manually imported releases and unrelated directories retain their identity", async () => {
  const { skills, installer } = setup((_, version) => archive(version));
  const target = join(skills, "demo");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), manifest("1.0.0"));
  expect(await installer.versions([id])).toEqual({ [id]: "1.0.0" });
  writeFileSync(join(target, "SKILL.md"), manifest("1.0.0").replace(id, randomUUID()));
  await expect(installer.install(ticket("1.0.1"))).rejects.toThrow("其他内容占用");
  writeFileSync(join(target, "SKILL.md"), manifest());
  expect(await installer.install(ticket("1.0.1"))).toMatchObject({ kind: "confirm", previousVersion: null });
  expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(manifest());
});

test("download or metadata validation failure leaves the previously installed tree intact", async () => {
  const { skills, installer } = setup((_, version) => version === "1.0.0" ? archive(version) : archive("9.0.0"));
  await installer.install(ticket("1.0.0"));
  await expect(installer.install(ticket("1.0.1"))).rejects.toThrow("不符");
  await expect(new TeamSkillInstaller(new SkillCatalog(skills, skills), async () => { throw new Error("network offline"); })
    .install(ticket("1.0.1"))).rejects.toThrow("network offline");
  expect(readFileSync(join(skills, "demo", "SKILL.md"), "utf8")).toBe(manifest("1.0.0"));
  expect(existsSync(join(skills, ".lxe-team-install/next"))).toBe(false);
});

test("checking versions restores an interrupted directory replacement", async () => {
  const { skills, installer } = setup((_, v) => archive(v));
  await installer.install(ticket("1.0.0"));
  const stage = join(skills, ".lxe-team-install");
  writeFileSync(join(stage, "target.json"), JSON.stringify({ path: "demo", nextInode: "0" }));
  renameSync(join(skills, "demo"), join(stage, "previous"));
  expect(await installer.versions([id])).toEqual({ [id]: "1.0.0" });
  expect(readFileSync(join(skills, "demo", "assets/example.txt"), "utf8")).toBe("1.0.0");
});

test("download stream must match signed size and checksum", async () => {
  const data = Buffer.from("ZIP"), hash = createHash("sha256").update(data).digest("hex");
  expect(await readTeamZip(new Response(data), 3, hash)).toEqual(data);
  await expect(readTeamZip(new Response(data), 2, hash)).rejects.toThrow("大小");
  await expect(readTeamZip(new Response(data), 3, "0".repeat(64))).rejects.toThrow("校验失败");
});

test("only current tickets for the team's HTTPS bucket may start a download", async () => {
  const base = ticket("1.0.0");
  for (const downloadUrl of [storageUrl.replace("https:", "http:"), storageUrl.replace("dataloom-rdqueaxi.feishucdn.com", "unrelated.example"),
    storageUrl.replace("bucket_aadk3bkqatkfw", "another-bucket"), storageUrl.split("?")[0]!]) {
    await expect(downloadTeamSkill({ ...base, downloadUrl })).rejects.toThrow("下载地址");
  }
  await expect(downloadTeamSkill({ ...base, expiresAt: new Date(0).toISOString() })).rejects.toThrow("已过期");
  await expect(downloadTeamSkill({ ...base, size: -1 })).rejects.toThrow("无效");
});
