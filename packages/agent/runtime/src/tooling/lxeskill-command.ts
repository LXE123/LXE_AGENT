import type { JsonObject } from "@lxe/protocol";
import { readFileSync } from "node:fs";

export interface ArtifactPathDeclaration {
  field: string;
  role: "deliverable" | "model_input" | "diagnostic";
}

export interface LxeSkillCommandDefinition {
  command: string;
  name: string;
  module?: string;
  visibility: "business" | "browser" | "maintenance" | "internal";
  ownerSkills: string[];
  artifactPaths?: ArtifactPathDeclaration[];
}

interface LxeSkillCatalogEntry {
  name: string;
  [key: string]: unknown;
}

interface LxeSkillCatalogDocument {
  protocol_version: "1";
  entries: LxeSkillCatalogEntry[];
}

const artifactPathsOf = (
  raw: Record<string, unknown>,
  entryName: string,
): ArtifactPathDeclaration[] => {
  const declarations = Array.isArray(raw.artifact_paths) ? raw.artifact_paths : [];
  return declarations.map((value) => {
    const item = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const field = String(item.field ?? "").trim();
    const role = String(item.role ?? "").trim() as ArtifactPathDeclaration["role"];
    if (!/^[A-Za-z_]\w*(?:\[\])?(?:\.[A-Za-z_]\w*(?:\[\])?)*$/u.test(field)
      || !["deliverable", "model_input", "diagnostic"].includes(role)) {
      throw new Error(`invalid artifact path declaration: ${entryName}`);
    }
    return { field, role };
  });
};

export function loadLxeSkillCommandCatalog(path: string): LxeSkillCommandDefinition[] {
  const document = JSON.parse(readFileSync(path, "utf8")) as LxeSkillCatalogDocument;
  if (document.protocol_version !== "1" || !Array.isArray(document.entries)) {
    throw new Error("invalid lxeskill command catalog protocol");
  }
  return document.entries.map((entry) => {
    const raw = entry as Record<string, unknown>;
    const commandPath = Array.isArray(raw.command_path)
      ? raw.command_path.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const visibility = String(raw.visibility ?? "internal") as LxeSkillCommandDefinition["visibility"];
    if (commandPath.length === 0 || !["business", "browser", "maintenance", "internal"].includes(visibility)) {
      throw new Error(`invalid lxeskill catalog entry: ${entry.name}`);
    }
    const artifactPaths = artifactPathsOf(raw, entry.name);
    return {
      command: `lxeskill ${commandPath.join(" ")}`,
      name: entry.name,
      ...(String(raw.module ?? "").trim() ? { module: String(raw.module).trim() } : {}),
      visibility,
      ownerSkills: Array.isArray(raw.owner_skills) ? raw.owner_skills.map((item) => String(item)) : [],
      ...(artifactPaths.length ? { artifactPaths } : {}),
    };
  });
}

export interface LxeSkillInvocation {
  command: string;
  commandId: string;
  ownerSkills?: string[];
}

const normalize = (value: string): string => value.trim().replaceAll(/\s+/gu, " ");

export function matchLxeSkillInvocation(
  rawCommand: unknown,
  knownCommands?: ReadonlyMap<string, readonly string[]>,
): LxeSkillInvocation | undefined {
  const command = normalize(String(rawCommand ?? ""));
  if (!/^lxeskill(?:\.cmd)?\s+/iu.test(command)) return undefined;
  const canonical = command.replace(/^lxeskill\.cmd(?=\s)/iu, "lxeskill");
  if (knownCommands) {
    const matches = [...knownCommands.entries()]
      .filter(([candidate]) => {
        const normalizedCandidate = normalize(candidate);
        return canonical.toLowerCase() === normalizedCandidate.toLowerCase()
          || canonical.toLowerCase().startsWith(`${normalizedCandidate.toLowerCase()} `);
      })
      .sort((left, right) => right[0].length - left[0].length);
    const matched = matches[0];
    if (!matched) return undefined;
    const stableCommand = normalize(matched[0]);
    return {
      command: stableCommand,
      commandId: stableCommand.slice("lxeskill ".length),
      ownerSkills: [...matched[1]],
    };
  }
  const tokens = canonical.split(" ");
  const commandTokens: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) break;
    commandTokens.push(token);
  }
  if (commandTokens.length === 0) return undefined;
  return {
    command: `lxeskill ${commandTokens.join(" ")}`,
    commandId: commandTokens.join(" "),
  };
}

export const classifyLxeSkillInput = (
  input: JsonObject,
  knownCommands: ReadonlyMap<string, readonly string[]>,
): LxeSkillInvocation | undefined => matchLxeSkillInvocation(input.command, knownCommands);
