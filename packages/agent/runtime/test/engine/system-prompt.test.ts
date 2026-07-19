import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, SYSTEM_PROMPT_CACHE_BREAKPOINT } from "../../src/engine/system-prompt";

describe("system prompt builder", () => {
  test("keeps stable policy before the cache boundary and runtime context after it", () => {
    const prompt = buildSystemPrompt({
      soul: "Careful agent.",
      platform: "feishu",
      provider: "anthropic",
      model: "claude-test",
      skillPrompt: "## Available Skills\n- one",
      workspaceInstructions: "## Workspace Instructions\nFollow the project rules.",
      workspace: {
        directory: "/workspace/project",
        worktree: "/workspace",
      },
      now: new Date("2026-07-12T00:00:00Z"),
    });
    const [stable, volatile] = prompt.split(SYSTEM_PROMPT_CACHE_BREAKPOINT);
    expect(stable).toContain("Careful agent.");
    expect(stable).toContain("Safety & Boundaries");
    expect(stable).toContain("Attachment Handling");
    expect(stable).toContain("cause_known=true");
    expect(stable).toContain("preserve the actual observed error");
    expect(stable).toContain("tested mapping_id");
    expect(volatile).toContain("Available Skills");
    expect(volatile).toContain("Follow the project rules.");
    expect(volatile).toContain("Provider: anthropic");
    expect(volatile).toContain("Model: claude-test");
    expect(volatile).toContain("Platform: feishu");
    expect(volatile).toContain("Working directory: /workspace/project");
    expect(volatile).toContain("Git worktree root: /workspace");
    expect(volatile).not.toContain(`Server ${"scope"}`);
  });
});
