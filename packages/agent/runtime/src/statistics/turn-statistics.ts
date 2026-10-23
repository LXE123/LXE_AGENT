import { homedir } from "node:os";
import { resolve } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { skillPathKey } from "../tooling/skill-files";
import type { SkillActivationUsage, SkillExecutionUsage, ToolTurnUsage } from "../engine/types";

export interface CommandSkill {
  command: string;
  skill: string;
}

export interface TurnStatisticsOptions {
  directory: string;
  commandSkills?: () => Promise<readonly CommandSkill[]>;
  onError?: (error: unknown) => void;
}

/** Observes calls; never validates, authorizes, or changes tool execution. */
export class TurnStatistics {
  private readonly tools = new Map<string, ToolTurnUsage>();
  private readonly reads: SkillActivationUsage[] = [];
  private readonly commands: string[] = [];
  private locations: Readonly<Record<string, string>> = {};
  private modules: Readonly<Record<string, string>> = {};

  constructor(private readonly options: TurnStatisticsOptions) {}

  setSkills(locations: Readonly<Record<string, string>>, modules: Readonly<Record<string, string>>): void {
    this.locations = locations;
    this.modules = modules;
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
        if (skill) this.reads.push({ skill, module: this.modules[skill] ?? "" });
      }
      if (name === "exec" && typeof input.command === "string" && /^\s*lxeskill(?:\.cmd)?\s+/iu.test(input.command)) {
        this.commands.push(input.command.trim().replace(/^lxeskill\.cmd(?=\s)/iu, "lxeskill").replace(/\s+/gu, " "));
      }
    } catch (error) { this.options.onError?.(error); }
  }

  finish(name: string, durationMs: number, failed: boolean): void {
    const tool = this.tools.get(name);
    if (!tool) return;
    tool.duration_ms += durationMs;
    if (failed) tool.errors += 1;
  }

  async snapshot(): Promise<{ tools: ToolTurnUsage[]; activations: SkillActivationUsage[]; executions: SkillExecutionUsage[] }> {
    const executions: SkillExecutionUsage[] = [];
    if (this.commands.length && this.options.commandSkills) {
      try {
        const entries = [...await this.options.commandSkills()].sort((a, b) => b.command.length - a.command.length);
        for (const invocation of this.commands) {
          const entry = entries.find(item => invocation === item.command || invocation.startsWith(`${item.command} `));
          if (entry) executions.push({
            skill: entry.skill, module: this.modules[entry.skill] ?? "", command: entry.command.slice("lxeskill ".length),
          });
        }
      } catch (error) { this.options.onError?.(error); }
    }
    return { tools: [...this.tools.values()], activations: [...this.reads], executions };
  }
}
