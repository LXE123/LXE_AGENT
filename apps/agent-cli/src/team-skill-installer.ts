import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { SkillCatalog } from "@lxe/runtime";
import { parseTeamInstallTicket, validTeamVersion, type TeamInstallTicket, type TeamInstallResult } from "@lxe/desktop-protocol/team-skills";
import { downloadTeamSkill } from "./team-skill-download";
import { extractTeamSkill } from "./team-skill-archive";

const stageName = ".lxe-team-install";

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
    return this.catalog.entries();
  }

  async versions(ids: string[]) {
    const stage = join(this.catalog.userSkillsRoot, stageName);
    if (lstatSync(stage, { throwIfNoEntry: false })?.isDirectory() && existsSync(join(stage, "target.json")) &&
        lstatSync(join(stage, "installer-v1"), { throwIfNoEntry: false })?.isFile()) {
      const unlock = await lockfile.lock(stage, { realpath: false, retries: { retries: 20, minTimeout: 30, maxTimeout: 200 } });
      try { restoreSwap(stage, realpathSync(this.catalog.userSkillsRoot)); } finally { await unlock(); }
    }
    const result: Record<string, string> = {};
    for (const entry of this.inventory()) {
      const release = entry.manifest?.teamRelease;
      if (entry.source !== "user" || !release || !ids.includes(release.id) || !validTeamVersion(release.version)) continue;
      if (result[release.id]) throw new Error("本机存在多份相同 ID 的 Skill，请在 LXE 中整理后重试");
      result[release.id] = release.version;
    }
    return result;
  }

  async install(raw: TeamInstallTicket, replaceLocalName?: string): Promise<TeamInstallResult> {
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
      const matches = inventory.filter(entry => entry.source === "user" && entry.manifest?.teamRelease?.id === id);
      if (matches.length > 1) throw new Error("本机存在多份相同 ID 的 Skill");
      const existing = matches[0];
      const dest = existing ? realpathSync(existing.manifest!.root) : join(root, manifest.name);
      if (!inside(root, dest) || realpathSync(dirname(dest)) !== dirname(dest)) throw new Error("技能目录不属于 LXE 用户技能目录");
      const nameTaken = inventory.some(entry => entry.source !== "shared" &&
        entry.manifest?.name === manifest.name && realpathSync(entry.manifest.root) !== dest);
      if (nameTaken) throw new Error("LXE 另一个目录已包含同名 Skill，请先处理名称冲突");
      const stat = lstatSync(dest, { throwIfNoEntry: false });
      if (stat) {
        if (!stat.isDirectory() || realpathSync(dest) !== dest) throw new Error("同名路径不能作为安装目标");
        const local = existing ?? inventory.find(entry => entry.source === "user" && entry.manifest?.name === manifest.name && realpathSync(entry.manifest.root) === dest);
        const release = local?.manifest?.teamRelease;
        if (!local || (release?.id && release.id !== id)) throw new Error("同名目录已被其他内容占用");
        if (release?.id) {
          if (release.version.localeCompare(version, "en", { numeric: true }) > 0) throw new Error("本机版本较新，请刷新技能库");
          if (release.version === version) return version;
        } else if (replaceLocalName !== manifest.name) return { localName: manifest.name };
        writeFileSync(join(stage, "target.json"), JSON.stringify({ path: relative(root, dest), nextInode: lstatSync(next, { bigint: true }).ino.toString() }), { flag: "wx" });
        renameSync(dest, join(stage, "previous"));
      }
      renameSync(next, dest);
      try { this.catalog.forceRefresh(); } catch (error) {
        renameSync(dest, next);
        throw error;
      }
      return version;
    } finally {
      try { if (stageReady) restoreSwap(stage, root); } finally { await unlock(); }
    }
  }
}
