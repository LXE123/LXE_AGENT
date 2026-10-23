import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "@lxe/core";
import { SkillCatalog } from "@lxe/runtime";
import { createAgentRuntimeHost } from "../src/runtime-host";

test("runtime initialization scans once; idle time and health checks never rescan skills", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-skill-idle-"));
  const source = repositoryRoot(import.meta.dir);
  const skills = join(root, "skills"); mkdirSync(skills);
  const soul = join(root, "SOUL.md"); writeFileSync(soul, "Test instructions", "utf8");
  const scan = spyOn(SkillCatalog.prototype, "forceRefresh");
  const host = createAgentRuntimeHost({
    llmConfigRoot: join(source, "config", "llm"),
    dataRoot: root, legacyWorkspace: { directory: root, worktree: root },
    agentSoulPath: soul, skillsRoot: skills, userSkillsRoot: join(root, "user"),
    environment: { LOCAL_LOGS_ENABLED: "0", LXE_DATA_SERVER_ENABLED: "0" },
    emitter: { emit: async () => {}, typing: async () => {} },
  });
  try {
    await host.start();
    expect(scan).toHaveBeenCalledTimes(1);
    rmSync(skills, { recursive: true });
    await Bun.sleep(1_150);
    for (let i = 0; i < 3; i++) expect(host.health().ready).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
    await expect(host.dashboardCall({ operation: "skills.list", input: {} })).rejects.toThrow("repository Skill directory is missing");
  } finally {
    await host.stop(); scan.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
});
