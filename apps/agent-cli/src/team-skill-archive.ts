import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ZipReader, Uint8ArrayReader, type Entry } from "@zip.js/zip.js";
import { parseSkillManifest } from "@lxe/runtime";

export const TEAM_RECEIPT = ".lxe-team-release.json";
const maxExpanded = (30 * 1024 + 128) * 1024;

export function safeComponent(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !/[<>:"/\\|?*\x00-\x1f]/.test(name)
    && !/[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

/** The destination is a fresh private staging directory. Extract only regular files and directories. */
export async function extractTeamSkill(bytes: Buffer, stage: string, id: string, version: string) {
  const archive = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    const entries: Entry[] = [];
    for await (const entry of archive.getEntriesGenerator()) {
      if (entries.length === 250) throw new Error("ZIP 条目超过 250 个");
      entries.push(entry);
    }
    const files = entries.filter(e => !e.filename.startsWith("__MACOSX/") && !e.filename.endsWith("/.DS_Store") && e.filename !== ".DS_Store");
    const manifests = files.filter(e => !e.directory && e.filename.split("/").at(-1) === "SKILL.md");
    const path = manifests[0]?.filename;
    if (!path || manifests.length !== 1 || path.split("/").length > 2) throw new Error("ZIP 必须包含一个位于根目录或单层文件夹的 SKILL.md");
    const prefix = path.slice(0, -"SKILL.md".length);
    const types = new Map<string, { path: string; directory: boolean }>();
    let total = 0;
    for (const entry of files) {
      const kind = (entry.unixMode ?? 0) & 0o170000;
      if (entry.encrypted || (kind && kind !== (entry.directory ? 0o040000 : 0o100000))) throw new Error("ZIP 包含加密条目、链接或特殊文件");
      if (entry.filename.length > 512) throw new Error("ZIP 路径超出长度限制");
      if (!entry.filename.startsWith(prefix)) throw new Error("ZIP 文件位于技能目录之外");
      const raw = entry.filename.slice(prefix.length);
      if (!raw && entry.directory) continue;
      const parts = (entry.directory && raw.endsWith("/") ? raw.slice(0, -1) : raw).split("/");
      if (!parts.every(safeComponent) || parts.some(p => /^(?:\.git|\.env(?:\..*)?|\.lxe-team-release\.json)$/i.test(p))) throw new Error("ZIP 包含不支持的路径");
      for (let i = 1; i <= parts.length; i++) {
        const part = parts.slice(0, i).join("/");
        const key = part.normalize("NFKC").toLowerCase(), prior = types.get(key);
        const directory = i < parts.length || entry.directory;
        if (prior && (prior.path !== part || !directory || !prior.directory)) throw new Error("ZIP 路径冲突");
        types.set(key, { path: part, directory });
      }
      const target = join(stage, ...parts);
      if (entry.directory) { mkdirSync(target, { recursive: true }); continue; }
      if (entry.uncompressedSize > 10 * 1024 ** 2 || entry.uncompressedSize + total > maxExpanded) throw new Error("技能包解压大小超过上限");
      const chunks: Uint8Array[] = [];
      let length = 0;
      await entry.getData(new WritableStream<Uint8Array>({ write(chunk) {
        length += chunk.byteLength;
        if (length > entry.uncompressedSize) throw new Error("ZIP 条目大小校验失败");
        chunks.push(chunk);
      } }), { checkSignature: true });
      if (length !== entry.uncompressedSize) throw new Error("ZIP 条目长度不完整");
      total += length;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.concat(chunks), { flag: "wx", mode: (entry.unixMode ?? 0) & 0o111 ? 0o755 : 0o644 });
    }
    const manifest = parseSkillManifest(join(stage, "SKILL.md"), "user");
    if (!safeComponent(manifest.name) || manifest.name.startsWith(".") || manifest.name.length > 160) throw new Error("技能名称不能用作本地目录");
    if (manifest.teamRelease && (manifest.teamRelease.id !== id || manifest.teamRelease.version !== version)) throw new Error("SKILL.md 的平台 ID 或版本与下载凭据不符");
    return manifest;
  } finally { await archive.close(); }
}
