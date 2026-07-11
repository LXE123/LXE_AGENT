import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../src/tools";
import { registerToolSearch } from "../src/tool-search";

const definition = (name: string, exposure: "direct" | "deferred" = "direct") => ({
  name,
  description: `${name} capability`,
  input_schema: { type: "object" },
  source: exposure === "direct" ? "native" as const : "script" as const,
  exposure,
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
});

describe("tool registry exposure", () => {
  test("rejects duplicate names instead of silently overwriting", () => {
    const registry = new ToolRegistry();
    registry.register(definition("same"));
    expect(() => registry.register(definition("same"))).toThrow("duplicate tool name: same");
  });

  test("exposes deferred tools only after search and owner skill activation", async () => {
    const registry = new ToolRegistry();
    registry.register(definition("direct_tool"));
    registry.register(definition("remote_inventory", "deferred"));
    registry.register({ ...definition("owner_report", "deferred"), ownerSkills: ["reports"] });
    registerToolSearch(registry);
    const activated: string[] = [];
    const exposure = registry.createExposureState({
      allowedSkills: new Set(["reports"]),
      onSkillActivated: (name) => { activated.push(name); },
    });
    expect(exposure.schemas().map((tool) => tool.name).sort()).toEqual(["direct_tool", "tool_search"]);
    expect(exposure.search("inventory").map((tool) => tool.name)).toEqual(["remote_inventory"]);
    expect(exposure.schemas().map((tool) => tool.name)).toContain("remote_inventory");
    await exposure.activateSkill("reports");
    expect(exposure.schemas().map((tool) => tool.name)).toContain("owner_report");
    expect(activated).toEqual(["reports"]);
  });
});
