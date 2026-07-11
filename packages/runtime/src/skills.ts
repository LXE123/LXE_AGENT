import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse } from "yaml";

interface SkillPromptOptions {
  allowedTypes?: ReadonlySet<string>;
  disabledNames?: ReadonlySet<string>;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const manifests = (root: string): string[] => {
  const skillsRoot = join(root, "skills");
  if (!existsSync(skillsRoot)) return [];
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && basename(path) === "SKILL.md") output.push(path);
    }
  };
  walk(skillsRoot);
  return output;
};

export function buildSkillIndexPrompt(projectRoot: string, options: SkillPromptOptions = {}): string {
  const rows: string[] = [];
  for (const path of manifests(projectRoot)) {
    const content = readFileSync(path, "utf8");
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (!match?.[1]) continue;
    const metadata = object(parse(match[1]));
    const name = String(metadata.name ?? "").trim();
    const type = String(metadata.type ?? "default").trim() || "default";
    const description = String(metadata.description ?? "").trim().replaceAll(/\s+/g, " ");
    if (!name || options.disabledNames?.has(name)) continue;
    if (options.allowedTypes && !options.allowedTypes.has("*") && !options.allowedTypes.has(type)) continue;
    rows.push(`- ${name} (${type}): ${description}\n  Instructions: ${relative(projectRoot, path).replaceAll("\\", "/")}`);
  }
  if (rows.length === 0) return "";
  return [
    "## Available skills",
    "When a request matches a skill, use the read tool to load its SKILL.md before executing its workflow. Follow that file exactly.",
    ...rows.sort((left, right) => left.localeCompare(right)),
  ].join("\n");
}
