import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "@lxe/core";
import { ExecShellAdapter, TurnUsageSyncService } from "@lxe/runtime";
import { createAgentRuntimeHost } from "../src/runtime-host";

for (const cliState of ["missing", "failed", "ready"] as const) {
  test(`usage sync starts independently when lxeskill is ${cliState}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-usage-lifecycle-"));
    const skills = join(root, "skills"); mkdirSync(skills);
    const order: string[] = [];
    const originalStart = TurnUsageSyncService.prototype.start;
    const start = spyOn(TurnUsageSyncService.prototype, "start").mockImplementation(async function (this: TurnUsageSyncService) {
      order.push("usage");
      await originalStart.call(this);
    });
    const stop = spyOn(TurnUsageSyncService.prototype, "stop");
    const argv = spyOn(ExecShellAdapter.prototype, "lxeSkillArgv");
    const python = cliState === "missing" ? join(root, "missing-python")
      : cliState === "failed" ? process.execPath
      : join(repositoryRoot(import.meta.dir), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const host = createAgentRuntimeHost({
      dataRoot: root, legacyWorkspace: { directory: root, worktree: root },
      skillsRoot: skills, userSkillsRoot: join(root, "user"),
      llmConfigRoot: join(repositoryRoot(import.meta.dir), "config", "llm"),
      environment: { LOCAL_LOGS_ENABLED: "0", LXE_MANAGED_PYTHON: python, LXE_DATA_SERVER_ENABLED: "1", LXE_DATA_SERVER_URL: "https://fixture.invalid" },
      emitter: { emit: async () => {}, typing: async () => {} },
    });
    try {
      await host.start();
      expect(host.health().ready).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["usage"]);
      expect(argv).not.toHaveBeenCalled();
      expect(host.health()).not.toHaveProperty("lxeskill_available");
      expect(host.health()).not.toHaveProperty("lxeskill_message");
      await host.stop();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await host.stop();
      start.mockRestore(); stop.mockRestore(); argv.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
