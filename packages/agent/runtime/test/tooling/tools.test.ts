import { describe, expect, test } from "bun:test";
import { ToolRegistry, unknownToolFailureDetails } from "../../src/tooling/registry";
import { registerToolSearch } from "../../src/tooling/tool-search";
import { policyFor, testWorkspace } from "../workspace";

const definition = (name: string, exposure: "direct" | "deferred" = "direct") => ({
  name,
  description: `${name} capability`,
  input_schema: { type: "object" },
  source: "native" as const,
  exposure,
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
});

describe("tool registry exposure", () => {
  test("keeps real host permission errors while redacting secrets", () => {
    const details = unknownToolFailureDetails(
      "read",
      Object.assign(new Error("EPERM: operation not permitted, open 'C:\\private\\token.txt'; token=raw-secret"), {
        code: "EPERM",
      }),
    );
    expect(details.observed_message).toContain("EPERM: operation not permitted");
    expect(details.observed_message).toContain("token=[redacted]");
    expect(details.observed_message).not.toContain("raw-secret");
  });

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
    expect((await exposure.search("inventory")).map(tool => tool.name)).toEqual(["remote_inventory"]);
    expect(exposure.schemas().map((tool) => tool.name)).toContain("remote_inventory");
    await exposure.activateSkill("reports");
    expect(exposure.schemas().map((tool) => tool.name)).toContain("owner_report");
    expect(activated).toEqual(["reports"]);
  });

  test("does not authorize exec commands using skill ownership", async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...definition("exec"),
    });
    const outOfScope = registry.createExposureState({ allowedSkills: new Set(["fba-shipment-create"]) });
    const context = {
      session_id: "session",
      workspace: testWorkspace, executionPolicy: policyFor(testWorkspace.directory),
      exposureState: outOfScope,
      handle: {
        signal: new AbortController().signal,
        cancelled: false,
        drainSteering: () => [],
        registerProcess: () => () => undefined,
      },
    };

    await expect(registry.execute("exec", { command: "lxeskill browser store --action get_status" }, context))
      .resolves.toMatchObject({ content: [{ text: "ok" }] });
  });

  test("a failed load can be retried, and overlapping searches only record a match once", async () => {
    const registry = new ToolRegistry();
    registry.register(definition("inventory_lookup", "deferred"));
    let attempts = 0;
    const state = registry.createExposureState({ onToolsLoaded: async () => {
      if (++attempts === 1) throw new Error("transcript write failed");
    } });
    await expect(state.search("inventory")).rejects.toThrow("transcript write failed");
    expect(state.schemas()).toEqual([]);
    const [first, second] = await Promise.all([state.search("inventory"), state.search("inventory")]);
    expect(first.map(tool => tool.name)).toEqual(["inventory_lookup"]);
    expect(second).toEqual([]);
    expect(attempts).toBe(2);
  });

  test("restored references follow the server tool identity and current platform, skill access and schema", () => {
    const registry = new ToolRegistry();
    const state = registry.createExposureState({ loadedTools: [{ server: "docs", name: "find.notes" }],
      platform: "desktop", allowedSkills: new Set(["notes"]) });
    const original = { ...definition("mcp__docs__find_notes", "deferred"), source: "mcp" as const,
      connectorName: "docs", rawName: "find.notes", platforms: ["desktop"], ownerSkills: ["notes"] };
    registry.register(original);
    expect(state.isExposed(original.name)).toBe(true);
    registry.unregisterWhere(() => true);
    expect(state.schemas()).toEqual([]);
    registry.register({ ...original, rawName: "find_notes" });
    const renamed = { ...original, name: "mcp__docs__find_notes_hash", description: "New server description" };
    registry.register(renamed);
    expect(state.schemas()).toEqual([{ name: renamed.name, description: renamed.description, input_schema: renamed.input_schema }]);
    for (const override of [{ exposure: "hidden" as const }, { platforms: ["cli"] }, { ownerSkills: ["private"] }]) {
      registry.unregisterWhere(name => name === renamed.name);
      registry.register({ ...renamed, ...override });
      expect(state.schemas()).toEqual([]);
      expect(state.isExposed(renamed.name)).toBe(false);
    }
  });
});
