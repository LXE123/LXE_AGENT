import { describe, expect, test } from "bun:test";
import { matchLxeSkillInvocation } from "../src/lxeskill-command";
import { buildToolDisplayStep } from "../src/tool-display";

describe("lxeskill command recognition", () => {
  test("matches only a leading known command and chooses the longest path", () => {
    const known = new Map([
      ["lxeskill replenish inventory actual-export", ["inventory"]],
      ["lxeskill replenish inventory", ["short"]],
    ]);

    expect(matchLxeSkillInvocation(
      "lxeskill replenish inventory actual-export --store-name Demo --token secret",
      known,
    )).toEqual({
      command: "lxeskill replenish inventory actual-export",
      commandId: "replenish inventory actual-export",
      ownerSkills: ["inventory"],
    });
    expect(matchLxeSkillInvocation("echo lxeskill replenish inventory actual-export", known)).toBeUndefined();
    expect(matchLxeSkillInvocation("lxeskill unknown command", known)).toBeUndefined();
  });

  test("renders an exec call as a business skill without exposing parameters", () => {
    const step = buildToolDisplayStep(
      "tool-1",
      "exec",
      { command: "lxeskill fba shipment prepare-upload --context-file secret.json --token raw-secret" },
      "running",
      0,
    );

    expect(step.title).toBe("业务技能：fba shipment prepare-upload");
    expect(step.detail).toBe("");
    expect(JSON.stringify(step)).not.toContain("raw-secret");
    expect(JSON.stringify(step)).not.toContain("secret.json");
  });
});
