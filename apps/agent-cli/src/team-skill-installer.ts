import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { SkillCatalog, type SkillCatalogEntry } from "@lxe/runtime";
import { validTeamSkillId, validTeamVersion, parseTeamInstallTicket, type TeamInstallTicket, type TeamInstallResult } from "@lxe/desktop-protocol/team-skills";
import { downloadTeamSkill } from "./team-skill-download";
import { extractTeamSkill, TEAM_RECEIPT } from "./team-skill-archive";

type Release = { id: string; version: string; treeHash?: string };
const stageName = ".lxe-team-install";

function installedRelease(entry: SkillCatalogEntry): Release | undefined {
  if (!entry.manifest) return;
  const stamped = entry.manifest.teamRelease;
  const path = join(entry.manifest.root, TEAM_RECEIPT);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  let receipt: Release | undefined;
  if (stat) {
    if (!stat.isFile() || stat.size > 1024) throw new Error("无效的本地团队技能来源记录");
    receipt = JSON.parse(readFileSync(path, "utf8"));
  }
  const release = stamped ?? receipt;
  if (!release) return;
  if (!validTeamSkillId(release.id) || !validTeamVersion(release.version)) throw new Error("本地团队技能缺少有效的 ID 或版本");
  return receipt?.id === release.id && receipt.version === release.version ? receipt : release;
}

// An extracted package is bounded. Oversized or special local files always count as edits.
function treeHash(root: string): string {
  const digest = createHash("sha256");
  let bytesRead = 0;
  function visit(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === TEAM_RECEIPT) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      digest.update(JSON.stringify([relative(root, path), kind, stat.mode & 0o111]) + "\n");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && stat.size <= 10 * 1024 ** 2 && (bytesRead += stat.size) <= 31 * 1024 ** 2) {
        digest.update(createHash("sha256").update(readFileSync(path)).digest());
      } else digest.update(JSON.stringify([stat.size, stat.ctimeMs, stat.ino]));
    }
  }
  visit(root);
  return digest.digest("hex");
}

function inside(root: string, target: string) {
  const path = relative(root, target);
  return !!path && !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep) && path.split(sep)[0] !== stageName;
}

function restoreSwap(stage: string, root: string) {
  const previous = join(stage, "previous");
  const journal = join(stage, "target.json");
  if (existsSync(previous)) {
    const saved = JSON.parse(readFileSync(journal, "utf8"));
    const dest = resolve(root, saved.path);
    if (!inside(root, dest) || realpathSync(dirname(dest)) !== dirname(dest)) throw new Error("无法恢复上次安装的目标目录");
    if (!lstatSync(dest, { throwIfNoEntry: false })) renameSync(previous, dest);
    else if (lstatSync(dest, { bigint: true }).ino.toString() === saved.nextInode && !existsSync(join(stage, "next"))) {
      rmSync(previous, { recursive: true });
    } else throw new Error("安装目标已变化，上次安装的备份保留在 " + previous);
  }
  rmSync(journal, { force: true });
  rmSync(join(stage, "next"), { recursive: true, force: true });
}

export class TeamSkillInstaller {
  constructor(private readonly catalog: SkillCatalog, private readonly download = downloadTeamSkill) {}

  private inventory() {
    this.catalog.forceRefresh();
    return this.catalog.entries().map(entry => {
      try { return { entry, release: entry.source === "user" ? installedRelease(entry) : undefined }; }
      catch (error) { return { entry, error, release: undefined }; }
    });
  }

  async versions(ids: string[]) {
    const stage = join(this.catalog.userSkillsRoot, stageName);
    if (lstatSync(stage, { throwIfNoEntry: false })?.isDirectory() && existsSync(join(stage, "target.json")) &&
        lstatSync(join(stage, "installer-v1"), { throwIfNoEntry: false })?.isFile()) {
      const unlock = await lockfile.lock(stage, { realpath: false, retries: { retries: 20, minTimeout: 30, maxTimeout: 200 } });
      try { restoreSwap(stage, realpathSync(this.catalog.userSkillsRoot)); } finally { await unlock(); }
    }
    const result: Record<string, string> = {};
    for (const { release } of this.inventory()) {
      if (!release || !ids.includes(release.id)) continue;
      if (result[release.id]) throw new Error("本机存在多份相同 ID 的 Skill，请在 LXE 中整理后重试");
      result[release.id] = release.version;
    }
    return result;
  }

  async install(raw: TeamInstallTicket, fingerprint?: string): Promise<TeamInstallResult> {
    const ticket = parseTeamInstallTicket(raw);
    const { skillId: id, version } = ticket;
    const bytes = await this.download(ticket);
    mkdirSync(this.catalog.userSkillsRoot, { recursive: true });
    const root = realpathSync(this.catalog.userSkillsRoot);
    const stage = join(root, stageName);
    const unlock = await lockfile.lock(stage, { realpath: false, retries: { retries: 20, minTimeout: 30, maxTimeout: 200 } });
    const next = join(stage, "next");
    let stageReady = false;
    try {
      const marker = join(stage, "installer-v1");
      if (!lstatSync(stage, { throwIfNoEntry: false })) {
        mkdirSync(stage, { mode: 0o700 });
        writeFileSync(marker, "", { flag: "wx" });
      }
      if (!lstatSync(stage).isDirectory() || !lstatSync(marker, { throwIfNoEntry: false })?.isFile()) throw new Error("安装暂存目录已被占用");
      restoreSwap(stage, root);
      stageReady = true;
      mkdirSync(next);
      const manifest = await extractTeamSkill(bytes, next, id, version);
      const inventory = this.inventory();
      const matches = inventory.filter(item => item.release?.id === id);
      if (matches.length > 1) throw new Error("本机存在多份相同 ID 的 Skill");
      const existing = matches[0];
      const dest = existing ? realpathSync(existing.entry.manifest!.root) : join(root, manifest.name);
      if (!inside(root, dest) || realpathSync(dirname(dest)) !== dirname(dest)) throw new Error("技能目录不属于 LXE 用户技能目录");
      const nameTaken = inventory.some(({ entry }) => entry.source !== "shared" &&
        entry.manifest?.name === manifest.name && realpathSync(entry.manifest.root) !== dest);
      if (nameTaken) throw new Error("LXE 另一个目录已包含同名 Skill，请先处理名称冲突");
      const stat = lstatSync(dest, { throwIfNoEntry: false });
      if (stat) {
        if (!stat.isDirectory() || realpathSync(dest) !== dest) throw new Error("同名路径不能作为安装目标");
        const local = existing ?? inventory.find(({ entry }) => entry.source === "user" && entry.manifest && realpathSync(entry.manifest.root) === dest);
        if (!local || (local.release && local.release.id !== id)) throw new Error("同名目录已被其他内容占用");
        if (local.error) throw local.error;
        const previous = local.release?.version;
        if (previous && previous.localeCompare(version, "en", { numeric: true }) > 0) throw new Error("本机版本较新，请刷新技能库");
        if (previous === version) return { kind: "installed", version };
        const currentHash = treeHash(dest);
        if (local.release?.treeHash !== currentHash) {
          const token = createHash("sha256").update(JSON.stringify([id, version, local.entry.id, currentHash])).digest("hex");
          if (fingerprint !== token) return { kind: "confirm", fingerprint: token, name: manifest.name, previousVersion: previous ?? null };
        }
      } else if (fingerprint || existing) throw new Error("本机技能目录已发生变化，请重试");
      writeFileSync(join(next, TEAM_RECEIPT), JSON.stringify({ id, version, treeHash: treeHash(next) }), { flag: "wx" });
      if (stat) {
        writeFileSync(join(stage, "target.json"), JSON.stringify({ path: relative(root, dest), nextInode: lstatSync(next, { bigint: true }).ino.toString() }), { flag: "wx" });
        renameSync(dest, join(stage, "previous"));
      }
      renameSync(next, dest);
      try { this.catalog.forceRefresh(); } catch (error) {
        renameSync(dest, next);
        throw error;
      }
      return { kind: "installed", version };
    } finally {
      try { if (stageReady) restoreSwap(stage, root); } finally { await unlock(); }
    }
  }
}
