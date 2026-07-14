import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, SYSTEM_PROMPT_CACHE_BREAKPOINT } from "../../src/engine/system-prompt";

describe("system prompt builder", () => {
  test("keeps stable policy before the cache boundary and runtime context after it", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-prompt-"));
    writeFileSync(join(root, "SOUL.md"), "Careful agent.", "utf8");
    const prompt = buildSystemPrompt({
      projectRoot: root,
      platform: "feishu",
      provider: "anthropic",
      model: "claude-test",
      skillPrompt: "## Available Skills\n- one",
      workspace: "/workspace",
      now: new Date("2026-07-12T00:00:00Z"),
    });
    const [stable, volatile] = prompt.split(SYSTEM_PROMPT_CACHE_BREAKPOINT);
    expect(stable).toContain("Careful agent.");
    expect(stable).toContain("Safety & Boundaries");
    expect(stable).toContain("Attachment Handling");
    expect(volatile).toContain("Available Skills");
    expect(volatile).toContain("Provider: anthropic");
    expect(volatile).toContain("Model: claude-test");
    expect(volatile).toContain("Platform: feishu");
    expect(volatile).toContain("/workspace");
  });
});
