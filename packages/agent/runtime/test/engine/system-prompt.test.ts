import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, SYSTEM_PROMPT_CACHE_BREAKPOINT } from "../../src/engine/system-prompt";

describe("system prompt builder", () => {
  test("advertises Lark only when available, outside the stable cache prefix", () => {
    const options = {
      platform: "desktop", provider: "test", model: "test", skillPrompt: "",
      workspace: { directory: "/workspace", worktree: "/workspace" },
    };
    for (const available of [undefined, false, true]) {
      const prompt = buildSystemPrompt({ ...options, ...(available === undefined ? {} : { larkCliAvailable: available }) });
      const [stable, volatile] = prompt.split(SYSTEM_PROMPT_CACHE_BREAKPOINT);
      expect(stable).not.toContain("lark-cli");
      expect(volatile!.includes("lark-cli skills list")).toBe(available === true);
      expect(volatile!.includes("lark-cli --help")).toBe(available === true);
    }
  });

  test("keeps stable policy before the cache boundary and runtime context after it", () => {
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
    expect(stable).toStartWith("## Safety & Boundaries\n");
    expect(stable).toContain("Safety & Boundaries");
    expect(stable).toContain("An explicit user request authorizes the actions within its stated scope.");
    expect(stable).toContain("Previously granted authorization remains valid within its stated task, targets, operations, and duration across conversation turns, unless revoked or expired.");
    expect(stable).toContain("Do not infer authorization or expand its scope.");
    expect(stable).toContain("Ask only when authorization is missing or its scope is unclear.");
    expect(stable).toContain("Resolve instruction conflicts using the applicable instruction hierarchy and scope.");
    expect(stable).toContain("Ask the user when the conflict remains unresolved or leaves the requested action or authorization unclear.");
    expect(prompt).not.toContain("unless this turn explicitly asks");
    expect(prompt).not.toContain("Approval in one context does not carry over to the next.");
    expect(prompt).not.toContain("If instructions conflict, pause and ask.");
    expect(stable).toContain("Attachment Handling");
    expect(stable).toContain("cause_known=true");
    expect(stable).toContain("preserve the actual observed error");
    expect(stable).toContain("tested mapping_id");
    expect(volatile).toContain("Available Skills");
    expect(volatile).toContain("Follow the project rules.");
    expect(volatile).not.toContain("Provider: anthropic");
    expect(volatile).not.toContain("Model: claude-test");
    expect(volatile).not.toContain("Platform: feishu");
    expect(volatile).not.toContain("Working directory: /workspace/project");
    expect(volatile).not.toContain("Git worktree root: /workspace");
    expect(volatile).toContain("The latest environment context specifies the permission mode");
    expect(volatile).toContain("exec, write and edit");
    expect(volatile).not.toContain(`Server ${"scope"}`);
  });

  test("omits the dataset section entirely when no registry is supplied", () => {
    const prompt = buildSystemPrompt({
      platform: "feishu",
      provider: "anthropic",
      model: "claude-test",
      skillPrompt: "",
      workspace: { directory: "/workspace/project", worktree: "/workspace" },
    });
    expect(prompt).not.toContain("## Data Directories");
    expect(prompt).not.toContain("Artifact root:");
  });
});
