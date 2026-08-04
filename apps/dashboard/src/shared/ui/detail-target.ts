import type { SkillPayload, ToolPayload } from "../../api/payloads";

export type DetailTarget =
  | { type: "tool"; item: ToolPayload; title: string }
  | { type: "skill"; item: SkillPayload; title: string }
  | null;
