export const TEAM_SKILLS_URL = "https://qcnd7w5806gy.feishuapp.com/app/app_17gftabyhpd";

export type TeamSkillsBrowserCommand = "state" | "back" | "forward" | "reload" | { url: string };
export interface TeamSkillsBrowserState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}
