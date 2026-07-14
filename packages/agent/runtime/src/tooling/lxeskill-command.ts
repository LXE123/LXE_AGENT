import type { JsonObject } from "@lxe/protocol";

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
