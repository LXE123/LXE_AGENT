import type { BackgroundTaskPayload, SkillPayload, ToolPayload } from "../payloads";

export type DetailTarget =
  | { type: "tool"; item: ToolPayload; title: string }
  | { type: "skill"; item: SkillPayload; title: string }
  | { type: "task"; item: BackgroundTaskPayload; title: string }
  | null;
