import { describe, expect, test } from "bun:test";
import { ToolRegistry, unknownToolFailureDetails } from "../../src/tooling/registry";
import { registerToolSearch } from "../../src/tooling/tool-search";
import { testWorkspace } from "../workspace";

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
    expect(exposure.search("inventory").map((tool) => tool.name)).toEqual(["remote_inventory"]);
    expect(exposure.schemas().map((tool) => tool.name)).toContain("remote_inventory");
    await exposure.activateSkill("reports");
    expect(exposure.schemas().map((tool) => tool.name)).toContain("owner_report");
    expect(activated).toEqual(["reports"]);
  });

  test("does not authorize classified invocations: the CLI owns command scope", async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...definition("exec"),
      classifyInvocation: () => ({ ownerSkills: ["ziniao-browser"] }),
    });
    const outOfScope = registry.createExposureState({ allowedSkills: new Set(["fba-shipment-create"]) });
    const context = {
      session_id: "session",
      workspace: testWorkspace,
      exposureState: outOfScope,
      handle: {
        signal: new AbortController().signal,
        cancelled: false,
        drainSteering: () => [],
        registerProcess: () => () => undefined,
      },
    };

    await expect(registry.execute("exec", { command: "lxeskill browser page" }, context))
      .resolves.toMatchObject({ content: [{ text: "ok" }] });
  });
});
