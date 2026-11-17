export const TEAM_SKILLS_URL = "https://qcnd7w5806gy.feishuapp.com/app/app_17gftabyhpd";

const libraryAliasOrigin = "https://qcnd7w5806gy.feishu.link";
// The Miaoda FileService signs objects in this application's storage bucket.
const storageOrigin = "https://dataloom-rdqueaxi.feishucdn.com";
const storagePrefix = "/4577945282/bucket_aadk3bkqatkfw/";
export const MAX_TEAM_ZIP = (10 * 1024 + 128) * 1024;
export type TeamInstallTicket = {
  skillId: string; version: string; downloadUrl: string; expiresAt: string; size: number; sha256: string;
};

export function parseTeamInstallTicket(raw: unknown): TeamInstallTicket {
  if (!raw || typeof raw !== "object") throw new Error("无效的技能安装凭据");
  const { skillId, version, downloadUrl, expiresAt, size, sha256 } = raw as Partial<TeamInstallTicket>;
  if (!validTeamSkillId(skillId) || !validTeamVersion(version) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_TEAM_ZIP ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
      typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) throw new Error("无效的技能安装凭据");
  if (Date.parse(expiresAt) <= Date.now()) throw new Error("技能下载凭据已过期，请重新点击安装或更新");
  const url = typeof downloadUrl === "string" && downloadUrl.length <= 8192 ? URL.parse(downloadUrl) : null;
  if (!url || url.origin !== storageOrigin || url.username || url.password || url.hash ||
      !url.pathname.startsWith(storagePrefix) || url.pathname.length <= storagePrefix.length ||
      !url.searchParams.get("sign")) throw new Error("下载地址不属于团队技能库存储");
  return { skillId, version, downloadUrl: url.href, expiresAt, size, sha256 };
}
export const validTeamSkillId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
export const validTeamVersion = (version: unknown): version is string =>
  typeof version === "string" && /^[1-9]\d{0,12}\.\d\.\d$/.test(version);
export function isTeamSkillsPage(raw: string): boolean {
  const url = URL.parse(raw);
  const library = new URL(TEAM_SKILLS_URL);
  return !!url && !url.username && !url.password &&
    (url.origin === library.origin || url.origin === libraryAliasOrigin) &&
    (url.pathname === library.pathname || url.pathname.startsWith(library.pathname + "/"));
}

export type TeamSkillsBrowserCommand = "state" | "back" | "forward" | "reload" | { url: string };
export interface TeamSkillsBrowserState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}
