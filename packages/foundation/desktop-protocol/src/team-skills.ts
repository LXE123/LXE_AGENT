export const TEAM_SKILLS_URL = "https://qcnd7w5806gy.feishuapp.com/app/app_17gftabyhpd";

export const TEAM_SKILLS_MCP_URL = "https://qcnd7w5806gy.feishu.link/mcp/app_17gftabyhpd";
export const validTeamSkillId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
export const validTeamVersion = (version: unknown): version is string =>
  typeof version === "string" && /^[1-9]\d{0,12}\.\d\.\d$/.test(version);
export function isTeamSkillsPage(raw: string): boolean {
  const url = URL.parse(raw);
  const library = new URL(TEAM_SKILLS_URL);
  return !!url && !url.username && !url.password &&
    (url.origin === library.origin || url.origin === new URL(TEAM_SKILLS_MCP_URL).origin) &&
    (url.pathname === library.pathname || url.pathname.startsWith(library.pathname + "/"));
}

export type TeamInstallResult =
  | { kind: "installed"; version: string }
  | { kind: "confirm"; fingerprint: string; name: string; previousVersion: string | null };

export type TeamSkillsBrowserCommand = "state" | "back" | "forward" | "reload" | { url: string };
export interface TeamSkillsBrowserState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}
