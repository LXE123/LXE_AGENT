import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, SYSTEM_PROMPT_CACHE_BREAKPOINT } from "../../src/engine/system-prompt";

describe("system prompt builder", () => {
  test("changes only volatile context when Lark availability changes", () => {
    const options = {
      platform: "desktop", provider: "test", model: "test", skillPrompt: "",
      workspace: { directory: "/workspace", worktree: "/workspace" },
    };
    const unavailable = buildSystemPrompt({ ...options, larkCliAvailable: false });
    expect(buildSystemPrompt(options)).toBe(unavailable);
    const [stable, volatile] = unavailable.split(SYSTEM_PROMPT_CACHE_BREAKPOINT);
    const [availableStable, availableVolatile] = buildSystemPrompt({ ...options, larkCliAvailable: true })
      .split(SYSTEM_PROMPT_CACHE_BREAKPOINT);
    expect(availableStable).toBe(stable);
    expect(availableVolatile).not.toBe(volatile);
  });

  test("places supplied skills and workspace instructions after the cache boundary", () => {
    const prompt = buildSystemPrompt({
      platform: "feishu",
      provider: "anthropic",
      model: "claude-test",
      skillPrompt: "## Available Skills\n- one",
      workspaceInstructions: "## Workspace Instructions\nFollow the project rules.",
      workspace: {
        directory: "/workspace/project",
        worktree: "/workspace",
      },
    });
    const [stable, volatile] = prompt.split(SYSTEM_PROMPT_CACHE_BREAKPOINT);
    for (const supplied of ["## Available Skills\n- one", "## Workspace Instructions\nFollow the project rules."]) {
      expect(stable).not.toContain(supplied);
      expect(volatile).toContain(supplied);
      expect(prompt.split(supplied)).toHaveLength(2);
    }
  });
});
