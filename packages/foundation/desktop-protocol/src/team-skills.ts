export const TEAM_SKILLS_URL = "https://qcnd7w5806gy.feishuapp.com/app/app_17gftabyhpd";

export interface NativeViewBounds { x: number; y: number; width: number; height: number }
export type TeamSkillsViewRequest =
  | { action: "open" | "close" }
  | { action: "present"; bounds: NativeViewBounds | null };
