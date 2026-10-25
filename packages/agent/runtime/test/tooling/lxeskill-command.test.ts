import { expect, test } from "bun:test";
import { join } from "node:path";
import { repositoryRoot } from "@lxe/core";
import { TurnStatistics } from "../../src/statistics/turn-statistics";
import { skillPathKey } from "../../src/tooling/skill-files";
import { buildToolDisplayStep } from "../../src/tooling/tool-display";

const root = repositoryRoot(import.meta.dir);
test("records repeated Skill reads and longest matching command calls without execution outcomes", async () => {
  let queries = 0;
  const stats = new TurnStatistics({ directory: root, commandSkills: async () => { queries++; return [
    { command: "lxeskill demo", skill: "short" }, { command: "lxeskill demo run", skill: "demo" },
  ]; } });
  stats.setSkills({ [skillPathKey(join(root, "skills/demo/SKILL.md"))]: "demo" }, { demo: "default" });
  stats.observe("read", { path: "skills/demo/SKILL.md" });
  stats.observe("read", { path: "skills/demo/SKILL.md" });
  stats.observe("read", { path: "other/SKILL.md" });
  stats.observe("read", { path: "skills/demo/SKILL.md" }, false);
  stats.observe("exec", { command: "lxeskill demo run --token private" });
  stats.finish("exec", 25, true);
  stats.observe("exec", { command: "lxeskill.cmd demo run > result.txt" });
  stats.observe("exec", { command: "echo lxeskill demo run" });
  expect(queries).toBe(0);
  const result = await stats.snapshot();
  expect(queries).toBe(1);
  expect(result.activations).toEqual(Array(2).fill({ skill: "demo", module: "default" }));
  expect(result.executions).toEqual(Array(2).fill({ skill: "demo", module: "default", command: "demo run" }));
  expect(result.tools).toContainEqual({ name: "exec", calls: 3, errors: 1, duration_ms: 25 });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("failed optional attribution preserves generic tool and read statistics", async () => {
  const errors: unknown[] = [];
  const stats = new TurnStatistics({ directory: root, commandSkills: async () => { throw new Error("CLI missing"); }, onError: error => errors.push(error) });
  stats.observe("exec", { command: "lxeskill demo run" });
  expect(await stats.snapshot()).toMatchObject({ tools: [{ name: "exec", calls: 1 }], executions: [] });
  expect(errors).toHaveLength(1);
});

test("exec cards retain the actual command without inferring a business skill", () => {
  const command = "lxeskill fba shipment prepare-upload --context-file report.json";
  const step = buildToolDisplayStep("tool-1", "exec", { command }, "running", 0);
  expect(step.title).toBe("Run command");
  expect(step.detail).toBe(command);
});
