import { homedir } from "node:os";
import { resolve } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { skillPathKey } from "../tooling/skill-files";
import type { SkillActivationUsage, SkillUse, ToolTurnUsage } from "../engine/types";
import { SkillCommandMatcher, type StatisticsShell } from "./skill-use-command";

export interface TurnStatisticsOptions {
  directory: string;
  shell?: StatisticsShell;
  onError?: (error: unknown) => void;
}

/** Observes calls; never validates, authorizes, or changes tool execution. */
export class TurnStatistics {
  private readonly tools = new Map<string, ToolTurnUsage>();
  private readonly reads: SkillActivationUsage[] = [];
  private readonly uses = new Map<string, SkillUse>();
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
        const shell = this.options.shell ?? (process.platform === "win32" ? "powershell" : "posix");
        const cwd = typeof input.cwd === "string" ? input.cwd : ".";
        const skill = this.commandMatcher.match(input.command, cwd, this.options.directory, shell);
        if (skill) this.recordUse(skill, "implicit");
      }
    } catch (error) { this.options.onError?.(error); }
  }

  finish(name: string, durationMs: number, failed: boolean): void {
    const tool = this.tools.get(name);
    if (!tool) return;
    tool.duration_ms += durationMs;
    if (failed) tool.errors += 1;
  }

  snapshot() {
    return { tools: [...this.tools.values()], activations: [...this.reads], uses: [...this.uses.values()] };
  }
}
