import labels from "../../../../config/skill-labels.json";

/** Display only: callers must keep the original name for identity and requests. */
export function skillDisplayName(name: string, locale: string): string {
  if (locale !== "zh" && locale !== "zh-CN") return name;
  return Object.hasOwn(labels, name) ? labels[name as keyof typeof labels] : name;
}
