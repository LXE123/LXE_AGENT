// Pure formatting helpers.
import type { UiText } from "./i18n";
import type { SkillPayload } from "../api/payloads";

const SKILL_TYPE_ORDER = ["default", "amazon_fba", "amazon_replenish"];

export function formatDate(value: number): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value * 1000));
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Number(value) || 0));
}

export function formatCompactNumber(value: number): string {
  const normalized = Math.max(0, Number(value) || 0);
  if (normalized < 1_000) return formatNumber(normalized);
  let [divisor, suffix] = normalized >= 1_000_000
    ? [1_000_000, "M"] as const
    : [1_000, "K"] as const;
  let scaled = normalized / divisor;
  if (suffix === "K" && Math.round(scaled * 10) / 10 >= 1_000) {
    divisor = 1_000_000;
    suffix = "M";
    scaled = normalized / divisor;
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(scaled)}${suffix}`;
}

export function formatDuration(value: number | null | undefined): string {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) {
    return "-";
  }
  return `${duration.toFixed(duration >= 10 ? 0 : 1)}s`;
}


export function formatDurationMs(value: number): string {
  const ms = Math.max(0, Number(value) || 0);
  if (ms <= 0) {
    return "-";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

export function skillTypeLabel(type: string, t: UiText): string {
  const normalized = String(type || "").trim();
  const labels: Record<string, string> = {
    default: t.skillTypes.default,
    amazon_fba: t.skillTypes.amazon_fba,
    amazon_replenish: t.skillTypes.amazon_replenish
  };
  return labels[normalized] || normalized || t.skillTypes.uncategorized;
}

function skillTypeRank(type: string): number {
  const index = SKILL_TYPE_ORDER.indexOf(String(type || "").trim());
  return index >= 0 ? index : SKILL_TYPE_ORDER.length;
}

export function groupSkillsByType(skills: SkillPayload[], t: UiText): Array<{ type: string; label: string; skills: SkillPayload[] }> {
  const groups = new Map<string, SkillPayload[]>();
  for (const skill of skills) {
    const type = String(skill.type || "").trim() || "uncategorized";
    groups.set(type, [...(groups.get(type) || []), skill]);
  }
  return Array.from(groups.entries())
    .map(([type, items]) => ({
      type,
      label: skillTypeLabel(type, t),
      skills: items.slice().sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => {
      const leftRank = skillTypeRank(left.type);
      const rightRank = skillTypeRank(right.type);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.label.localeCompare(right.label);
    });
}
