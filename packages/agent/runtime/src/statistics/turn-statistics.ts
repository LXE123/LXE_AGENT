import { homedir } from "node:os";
import { resolve } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { skillPathKey } from "../tooling/skill-files";
import type { SkillActivationUsage, SkillExecutionUsage, SkillUse, ToolTurnUsage } from "../engine/types";
import { SkillCommandMatcher, type StatisticsShell } from "./skill-use-command";

export interface CommandSkill {
  command: string;
  skill: string;
}

export interface TurnStatisticsOptions {
  directory: string;
  shell?: StatisticsShell;
  commandSkills?: () => Promise<readonly CommandSkill[]>;
  onError?: (error: unknown) => void;
}

// The host supplies one provider for its lifetime. Independent providers can have different catalogs.
const lastCatalog = new WeakMap<NonNullable<TurnStatisticsOptions["commandSkills"]>, readonly CommandSkill[]>();

/** Observes calls; never validates, authorizes, or changes tool execution. */
export class TurnStatistics {
  private readonly tools = new Map<string, ToolTurnUsage>();
  private readonly reads: SkillActivationUsage[] = [];
  private readonly commands: string[] = [];
  private readonly uses = new Map<string, SkillUse>();
  private readonly useCommands: string[][] = [];
  private locations: Readonly<Record<string, string>> = {};
  private modules: Readonly<Record<string, string>> = {};
  private commandMatcher = new SkillCommandMatcher(this.locations);

  constructor(private readonly options: TurnStatisticsOptions) {}

  setSkills(locations: Readonly<Record<string, string>>, modules: Readonly<Record<string, string>>): void {
    this.locations = locations;
    this.modules = modules;
    this.commandMatcher = new SkillCommandMatcher(locations);
  }

  recordUse(skill: string, source: SkillUse["source"]): void {
    if (source === "explicit" || !this.uses.has(skill)) {
      this.uses.set(skill, { skill, module: this.modules[skill] ?? "", source });
    }
  }

  observe(name: string, input: JsonObject, native = true): void {
    const tool = this.tools.get(name) ?? { name, calls: 0, errors: 0, duration_ms: 0 };
    tool.calls += 1;
    this.tools.set(name, tool);
    if (!native) return;
    try {
      if (name === "read" && typeof input.path === "string") {
        const requested = input.path.trim();
        const path = /^~[\\/]/u.test(requested) ? resolve(homedir(), requested.slice(2))
          : resolve(this.options.directory, requested);
        const skill = this.locations[skillPathKey(path)];
        if (skill) {
          this.reads.push({ skill, module: this.modules[skill] ?? "" });
          this.recordUse(skill, "implicit");
        }
      }
      if (name === "exec" && typeof input.command === "string") {
        if (/^\s*lxeskill(?:\.cmd)?\s+/iu.test(input.command)) {
          this.commands.push(input.command.trim().replace(/^lxeskill\.cmd(?=\s)/iu, "lxeskill").replace(/\s+/gu, " "));
        }
        const shell = this.options.shell ?? (process.platform === "win32" ? "powershell" : "posix");
        const cwd = typeof input.cwd === "string" ? input.cwd : ".";
        const match = this.commandMatcher.match(input.command, cwd, this.options.directory, shell);
        if (!match) return;
        if ("skill" in match) this.recordUse(match.skill, "implicit");
        else this.useCommands.push(match.command);
      }
    } catch (error) { this.options.onError?.(error); }
  }

  finish(name: string, durationMs: number, failed: boolean): void {
    const tool = this.tools.get(name);
    if (!tool) return;
    tool.duration_ms += durationMs;
    if (failed) tool.errors += 1;
  }

  async snapshot() {
    const executions: SkillExecutionUsage[] = [];
    const uses = new Map(this.uses);
    const provider = this.options.commandSkills;
    if (provider && (this.commands.length || this.useCommands.length)) {
      let entries: readonly CommandSkill[];
      try {
        entries = [...await provider()].sort((a, b) => b.command.length - a.command.length);
        lastCatalog.set(provider, entries);
        for (const invocation of this.commands) {
          const entry = entries.find(item => invocation === item.command || invocation.startsWith(`${item.command} `));
          if (entry) executions.push({
            skill: entry.skill, module: this.modules[entry.skill] ?? "", command: entry.command.slice("lxeskill ".length),
          });
        }
      } catch (error) {
        this.options.onError?.(error);
        entries = lastCatalog.get(provider) ?? [];
      }
      for (const args of this.useCommands) {
        const entry = entries.find(item => item.command.split(" ").every((word, i) => word === args[i]));
        if (entry && !uses.has(entry.skill)) {
          uses.set(entry.skill, { skill: entry.skill, module: this.modules[entry.skill] ?? "", source: "implicit" });
        }
      }
    }
    return { tools: [...this.tools.values()], activations: [...this.reads], executions, uses: [...uses.values()] };
  }
}
