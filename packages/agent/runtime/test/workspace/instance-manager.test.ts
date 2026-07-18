import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceContext } from "@lxe/protocol";
import { SkillCatalog } from "../../src/tooling/skills";
import {
  WorkspaceInstanceManager,
  type WorkspaceInstanceManagerOptions,
} from "../../src/workspace/instance-manager";

const roots: string[] = [];
const managers: WorkspaceInstanceManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll("test_cleanup")));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = (options: {
  maxInstances?: number;
  now?: () => number;
  debounceMs?: number;
  watchPath?: WorkspaceInstanceManagerOptions["watchPath"];
  idleTtlMs?: number;
  connectorPolicy?: { disabled: Set<string> };
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "lxe-workspace-instance-"));
  roots.push(root);
  const resourceRoot = join(root, "resources");
  const worktree = join(root, "worktree");
  mkdirSync(join(resourceRoot, "skills", "demo"), { recursive: true });
  mkdirSync(join(worktree, "packages", "app"), { recursive: true });
  writeFileSync(join(resourceRoot, "SOUL.md"), "Be practical.", "utf8");
  writeFileSync(
    join(resourceRoot, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ntype: default\ndescription: Demo workflow\n---\n# Demo\n",
    "utf8",
  );
  const catalog = new SkillCatalog(resourceRoot, join(root, "missing-user"), { refreshIntervalMs: 0 });
  const connectorStatePath = join(root, "connector-state.json");
  if (options.connectorPolicy) writeFileSync(connectorStatePath, '{"version":1}', "utf8");
  const manager = new WorkspaceInstanceManager({
    resourceRoot,
    skillCatalog: catalog,
    skillOptions: () => ({ allowedTypes: new Set(["default"]) }),
    checkIntervalMs: 0,
    debounceMs: options.debounceMs ?? 60_000,
    sweepIntervalMs: 0,
    ...(options.connectorPolicy ? {
      connectorStatePath,
      disabledConnectorIds: () => options.connectorPolicy!.disabled,
    } : {}),
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    ...(options.maxInstances === undefined ? {} : { maxInstances: options.maxInstances }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.watchPath ? { watchPath: options.watchPath } : {}),
  });
  managers.push(manager);
  const workspace = (directory = worktree, rootPath = worktree): WorkspaceContext => ({
    server_scope: "local",
    directory,
    worktree: rootPath,
  });
  return { root, resourceRoot, worktree, catalog, connectorStatePath, manager, workspace };
};

const replaceKeepingTimes = (path: string, content: string): void => {
  const before = statSync(path);
  writeFileSync(path, content, "utf8");
  utimesSync(path, before.atime, before.mtime);
};

describe("WorkspaceInstanceManager", () => {
  test("single-flights concurrent acquisition and shares one worktree search service", async () => {
    const { manager, workspace } = setup();
    const leases = await Promise.all(Array.from({ length: 100 }, () => manager.acquire(workspace())));
    expect(new Set(leases.map((lease) => lease.snapshot)).size).toBe(1);
    expect(new Set(leases.map((lease) => lease.search)).size).toBe(1);
    expect(manager.diagnostics().loads).toBe(1);
    for (const lease of leases) lease.release();
  });

  test("shares a worktree instance while building directory-specific AGENTS chains", async () => {
    const { manager, worktree, workspace } = setup();
    const directory = join(worktree, "packages", "app");
    writeFileSync(join(worktree, "AGENTS.md"), "Root instruction.", "utf8");
    writeFileSync(join(worktree, "packages", "AGENTS.md"), "Packages instruction.", "utf8");
    writeFileSync(join(directory, "AGENTS.md"), "App instruction.", "utf8");
    mkdirSync(join(directory, "child"));
    writeFileSync(join(directory, "child", "AGENTS.md"), "Child instruction.", "utf8");
    writeFileSync(join(directory, "CLAUDE.md"), "Claude instruction.", "utf8");

    const rootLease = await manager.acquire(workspace());
    const nestedLease = await manager.acquire(workspace(directory));
    expect(rootLease.search).toBe(nestedLease.search);
    expect(rootLease.snapshot.instructions_prompt).toContain("Root instruction.");
    expect(rootLease.snapshot.instructions_prompt).not.toContain("Packages instruction.");
    expect(nestedLease.snapshot.instructions_prompt).toContain("Root instruction.");
    expect(nestedLease.snapshot.instructions_prompt).toContain("Packages instruction.");
    expect(nestedLease.snapshot.instructions_prompt).toContain("App instruction.");
    expect(nestedLease.snapshot.instructions_prompt).not.toContain("Child instruction.");
    expect(nestedLease.snapshot.instructions_prompt).not.toContain("Claude instruction.");
    expect(nestedLease.snapshot.instructions_prompt).toContain("packages/app/AGENTS.md (scope: packages/app)");
    expect(nestedLease.snapshot.instructions_prompt.indexOf("Root instruction."))
      .toBeLessThan(nestedLease.snapshot.instructions_prompt.indexOf("App instruction."));
    expect(manager.diagnostics().instances).toBe(1);
    expect(manager.diagnostics().views).toBe(2);
    rootLease.release();
    nestedLease.release();
  });

  test("atomically replaces changed snapshots and keeps an acquired lease stable", async () => {
    const { manager, worktree, workspace } = setup();
    const path = join(worktree, "AGENTS.md");
    writeFileSync(path, "First version", "utf8");
    const oldLease = await manager.acquire(workspace());
    writeFileSync(path, "Second versio", "utf8");

    const result = await manager.reload(workspace(), "test_force");
    const newLease = await manager.acquire(workspace());
    expect(result.changed).toBe(true);
    expect(oldLease.snapshot.instructions_prompt).toContain("First version");
    expect(newLease.snapshot.instructions_prompt).toContain("Second versio");
    expect(newLease.snapshot.generation).toBeGreaterThan(oldLease.snapshot.generation);
    oldLease.release();
    newLease.release();
  });

  test("detects a missed watcher event with the acquire-time fingerprint fallback", async () => {
    const { manager, worktree, workspace } = setup();
    const path = join(worktree, "AGENTS.md");
    writeFileSync(path, "Before", "utf8");
    const before = await manager.acquire(workspace());
    before.release();
    writeFileSync(path, "After and changed", "utf8");
    const after = await manager.acquire(workspace());
    expect(after.snapshot.instructions_prompt).toContain("After and changed");
    after.release();
  });

  test("force reload rereads global content and invalidates every directory view", async () => {
    const connectorPolicy = { disabled: new Set<string>() };
    const { manager, resourceRoot, worktree, connectorStatePath, workspace } = setup({ connectorPolicy });
    const directory = join(worktree, "packages", "app");
    const nestedBefore = await manager.acquire(workspace(directory));
    const rootBefore = await manager.acquire(workspace());
    nestedBefore.release();
    rootBefore.release();

    replaceKeepingTimes(join(resourceRoot, "SOUL.md"), "Be adaptable.");
    replaceKeepingTimes(
      join(resourceRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ntype: default\ndescription: Other process\n---\n# Demo\n",
    );
    replaceKeepingTimes(connectorStatePath, '{"version":2}');
    connectorPolicy.disabled.add("feishu");

    const rootReload = await manager.reload(workspace(), "test_global_force");
    const nestedAfter = await manager.acquire(workspace(directory));
    expect(rootReload.changed).toBe(true);
    expect(nestedAfter.snapshot.soul).toBe("Be adaptable.");
    expect(nestedAfter.snapshot.skills.prompt).toContain("Other process");
    expect(nestedAfter.snapshot.skills.disabledConnectorIds).toEqual(["feishu"]);
    expect(nestedAfter.snapshot.generation).toBeGreaterThan(nestedBefore.snapshot.generation);
    nestedAfter.release();
  });

  test("does not advance generation when a forced reload finds identical content", async () => {
    const { manager, workspace } = setup();
    const lease = await manager.acquire(workspace());
    const generation = lease.snapshot.generation;
    lease.release();
    const result = await manager.reload(workspace(), "test_no_change");
    expect(result).toMatchObject({ changed: false, generation });
  });

  test("debounces watcher invalidation and reloads existing views automatically", async () => {
    const listeners: Array<(filename: string) => void> = [];
    const { manager, worktree, workspace } = setup({
      debounceMs: 0,
      watchPath: (_path, _options, listener) => {
        listeners.push(listener);
        return { close: () => undefined, unref: () => undefined };
      },
    });
    const path = join(worktree, "AGENTS.md");
    writeFileSync(path, "Watcher before", "utf8");
    const before = await manager.acquire(workspace());
    const generation = before.snapshot.generation;
    before.release();
    writeFileSync(path, "Watcher after", "utf8");
    for (const listener of listeners) listener("AGENTS.md");
    await Bun.sleep(10);
    expect(Number(manager.diagnostics().generation)).toBeGreaterThan(generation);
    const after = await manager.acquire(workspace());
    expect(after.snapshot.instructions_prompt).toContain("Watcher after");
    after.release();
  });

  test("keeps the last good snapshot when a reload fails", async () => {
    const { manager, worktree, workspace } = setup();
    const path = join(worktree, "AGENTS.md");
    writeFileSync(path, "Good instructions", "utf8");
    const good = await manager.acquire(workspace());
    good.release();
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));

    await expect(manager.reload(workspace(), "test_invalid_utf8")).rejects.toThrow("valid UTF-8");
    const fallback = await manager.acquire(workspace());
    expect(fallback.snapshot.instructions_prompt).toContain("Good instructions");
    fallback.release();
  });

  test("rejects AGENTS symlinks that escape the worktree", async () => {
    const { root, manager, worktree, workspace } = setup();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "Outside instruction", "utf8");
    symlinkSync(outside, join(worktree, "AGENTS.md"));
    await expect(manager.acquire(workspace())).rejects.toThrow("escapes the Git worktree");
  });

  test("rejects an oversized AGENTS file", async () => {
    const { manager, worktree, workspace } = setup();
    writeFileSync(join(worktree, "AGENTS.md"), Buffer.alloc(256 * 1_024 + 1, 65));
    await expect(manager.acquire(workspace())).rejects.toThrow("exceeds 262144 bytes");
  });

  test("rejects an oversized combined AGENTS instruction chain", async () => {
    const { manager, worktree, workspace } = setup();
    const directory = join(worktree, "packages", "app");
    for (const path of [
      join(worktree, "AGENTS.md"),
      join(worktree, "packages", "AGENTS.md"),
      join(directory, "AGENTS.md"),
    ]) writeFileSync(path, Buffer.alloc(180 * 1_024, 65));
    await expect(manager.acquire(workspace(directory))).rejects.toThrow("files exceed 524288 bytes");
  });

  test("defers disposal until active leases are released", async () => {
    const { manager, workspace } = setup();
    const lease = await manager.acquire(workspace());
    await manager.dispose(workspace(), "test");
    expect(manager.diagnostics().instances).toBe(1);
    lease.release();
    expect(manager.diagnostics().instances).toBe(0);
  });

  test("disposeAll also preserves active leases until release", async () => {
    const { manager, workspace } = setup();
    const lease = await manager.acquire(workspace());
    await manager.disposeAll("runtime_stop");
    expect(manager.diagnostics().instances).toBe(1);
    expect(lease.snapshot.soul).toBe("Be practical.");
    lease.release();
    expect(manager.diagnostics().instances).toBe(0);
  });

  test("evicts the least-recently-used inactive worktree at capacity", async () => {
    const { root, manager, workspace } = setup({ maxInstances: 1 });
    const firstRoot = workspace().worktree;
    const first = await manager.acquire(workspace());
    first.release();
    const secondRoot = join(root, "second-worktree");
    mkdirSync(secondRoot);
    const second = await manager.acquire(workspace(secondRoot, secondRoot));
    second.release();
    expect(manager.diagnostics().instances).toBe(1);
    const firstAgain = await manager.acquire(workspace(firstRoot, firstRoot));
    expect(manager.diagnostics().loads).toBe(3);
    firstAgain.release();
  });

  test("sweeps an idle worktree before creating the next instance", async () => {
    let now = 0;
    const { root, manager, workspace } = setup({ idleTtlMs: 50, now: () => now });
    const first = await manager.acquire(workspace());
    first.release();
    now = 100;
    const secondRoot = join(root, "ttl-worktree");
    mkdirSync(secondRoot);
    const second = await manager.acquire(workspace(secondRoot, secondRoot));
    expect(manager.diagnostics().instances).toBe(1);
    second.release();
  });
});
