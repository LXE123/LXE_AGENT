import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { JsonObject } from "@lxe/protocol";
import { repositoryRoot } from "@lxe/core";
import {
  registerCodingTools,
  type ProcessCompletionConsumeRequest,
} from "../../src/tooling/coding-tools";
import { ToolExecutionError, ToolRegistry } from "../../src/tooling/registry";
import { registerToolSearch } from "../../src/tooling/tool-search";
import { workspaceFor } from "../workspace";

const roots: string[] = [];
const projectRoot = repositoryRoot(import.meta.dir);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = (workspaceRoot: string = projectRoot, controller = new AbortController()) => ({
  session_id: "s1",
  turn_id: "turn-1",
  response_route_id: "route-1",
  workspace: workspaceFor(workspaceRoot),
  handle: {
    signal: controller.signal,
    cancelled: false,
    drainSteering: () => [],
    registerProcess: () => () => undefined,
  },
});

const sessionContext = (
  directory: string,
  worktree: string,
  sessionId: string,
) => ({
  ...context(directory),
  session_id: sessionId,
  workspace: workspaceFor(directory, worktree),
});

const onePixelPng = (): Uint8Array => {
  const crcTable = Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const chunk = (name: string, data: Uint8Array): Uint8Array => {
    const type = new TextEncoder().encode(name);
    const output = new Uint8Array(12 + data.byteLength);
    const view = new DataView(output.buffer);
    view.setUint32(0, data.byteLength);
    output.set(type, 4);
    output.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of [...type, ...data]) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    view.setUint32(8 + data.byteLength, (crc ^ 0xffffffff) >>> 0);
    return output;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, 1);
  new DataView(header.buffer).setUint32(4, 1);
  header.set([8, 6, 0, 0, 0], 8);
  const chunks = [chunk("IHDR", header), chunk("IDAT", deflateSync(new Uint8Array(5))), chunk("IEND", new Uint8Array())];
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks.map(Buffer.from)]));
};

describe("native coding tools", () => {
  test("isolates two session workspaces and background processes from the process cwd", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "lxe-workspace-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "lxe-workspace-b-"));
    const unrelated = mkdtempSync(join(tmpdir(), "lxe-process-cwd-"));
    const directoryA = join(rootA, "nested");
    const directoryB = join(rootB, "nested");
    mkdirSync(directoryA);
    mkdirSync(directoryB);
    roots.push(rootA, rootB, unrelated);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const contextA = sessionContext(directoryA, rootA, "session-a");
    const contextB = sessionContext(directoryB, rootB, "session-b");
    const previousCwd = process.cwd();
    try {
      process.chdir(unrelated);
      await Promise.all([
        registry.execute("write", { file_path: "same.txt", content: "from-a" }, contextA),
        registry.execute("write", { file_path: "same.txt", content: "from-b" }, contextB),
      ]);
      expect(readFileSync(join(directoryA, "same.txt"), "utf8")).toBe("from-a");
      expect(readFileSync(join(directoryB, "same.txt"), "utf8")).toBe("from-b");

      const cwdResult = await registry.execute("exec", {
        command: `"${process.execPath}" -e "console.log(process.cwd())"`,
      }, contextA);
      expect(String(cwdResult.content[0]?.text).replaceAll("\\", "/"))
        .toContain(directoryA.replaceAll("\\", "/"));

      const started = await registry.execute("exec", {
        command: `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`,
        background: true,
      }, contextA);
      const processId = String(started.content[0]?.text).match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
      expect(processId).toMatch(/^exec_/);
      if (!processId) throw new Error("missing background process id");
      expect(String((await registry.execute("process", { action: "list" }, contextB)).content[0]?.text))
        .not.toContain(String(processId));
      expect(String((await registry.execute("process", { action: "kill", session: processId }, contextB)).content[0]?.text))
        .toContain("不存在");
      await registry.execute("process", { action: "kill", session: processId }, contextA);
    } finally {
      process.chdir(previousCwd);
      await processes.stop();
    }
  });

  test("exposes compatible coding schemas and keeps file operations inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      businessCommands: new Map([["lxeskill replenish store resolve", ["replenishment-store-resolve"]]]),
    });
    expect(registry.schemas().map((item) => item.name)).toEqual([
      "read", "write", "edit", "grep", "find", "ls", "send_file", "exec", "process",
    ]);
    await registry.execute("write", { file_path: "src/a.txt", content: "hello\nworld\n" }, context(root));
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toBe("hello\nworld\n");
    await registry.execute("edit", { file_path: "src/a.txt", old_string: "world", new_string: "Bun" }, context(root));
    const read = await registry.execute("read", { path: "src/a.txt", offset: 2, limit: 1 }, context(root));
    expect(read.content[0]?.text).toContain("Bun");
    const grep = await registry.execute("grep", { pattern: "Bun", path: "src" }, context(root));
    expect(grep.content[0]?.text).toContain("a.txt");
    const find = await registry.execute("find", { pattern: "*.txt", path: "src" }, context(root));
    expect(find.content[0]?.text).toContain("a.txt");
    const ls = await registry.execute("ls", { path: "src" }, context(root));
    expect(ls.content[0]?.text).toContain("a.txt");
    await expect(registry.execute("read", { path: "../outside.txt" }, context(root))).rejects.toThrow("workspace");
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
    await processes.stop();
  });

  test("reads split-root skills and artifacts without making external roots writable", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lxe-coding-workspace-"));
    const root = workspaceRoot;
    const resourceRoot = mkdtempSync(join(tmpdir(), "lxe-coding-resource-"));
    const dataRoot = mkdtempSync(join(tmpdir(), "lxe-coding-data-"));
    const home = mkdtempSync(join(tmpdir(), "lxe-coding-home-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "lxe-coding-outside-"));
    roots.push(workspaceRoot, resourceRoot, dataRoot, home, outsideRoot);
    const repositorySkillsRoot = join(resourceRoot, "skills");
    const skillRoot = join(repositorySkillsRoot, "nested", "demo");
    const skillPath = join(skillRoot, "SKILL.md");
    const referencePath = join(skillRoot, "references", "help.md");
    const assetPath = join(skillRoot, "assets", "guide.txt");
    const artifactRoot = join(dataRoot, "artifacts");
    const artifactPath = join(artifactRoot, "report.txt");
    const userSkillPath = join(home, ".agents", "skills", "personal", "SKILL.md");
    const outsidePath = join(outsideRoot, "secret.txt");
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    mkdirSync(join(skillRoot, "assets"), { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    mkdirSync(dirname(userSkillPath), { recursive: true });
    mkdirSync(join(workspaceRoot, "skills", "nested", "demo"), { recursive: true });
    writeFileSync(skillPath, "---\nname: demo\ndescription: Bundled\n---\n# Bundled skill\n", "utf8");
    writeFileSync(referencePath, "reference text\n", "utf8");
    writeFileSync(assetPath, "asset text\n", "utf8");
    writeFileSync(artifactPath, "artifact text\n", "utf8");
    writeFileSync(userSkillPath, "---\nname: personal\ndescription: Personal\n---\n# Personal skill\n", "utf8");
    writeFileSync(join(workspaceRoot, "skills", "nested", "demo", "SKILL.md"), "# Workspace shadow\n", "utf8");
    writeFileSync(outsidePath, "secret\n", "utf8");
    symlinkSync(outsideRoot, join(skillRoot, "escaped"), process.platform === "win32" ? "junction" : "dir");

    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      repositorySkillsRoot,
      artifactRoot,
      homeDirectory: home,
      ripgrepPath: null,
    });
    const activated: string[] = [];
    const exposureState = registry.createExposureState({
      allowedSkills: new Set(["demo"]),
      onSkillActivated: (name) => { activated.push(name); },
    });
    const bundled = await registry.execute("read", { path: skillPath }, { ...context(root), exposureState });
    expect(String(bundled.content[0]?.text)).toContain("Bundled skill");
    expect(String(bundled.content[0]?.text)).not.toContain("Workspace shadow");
    expect(activated).toEqual(["demo"]);
    expect(String((await registry.execute("read", { path: referencePath }, context(root))).content[0]?.text))
      .toContain("reference text");
    expect(String((await registry.execute("read", {
      path: "~/.agents/skills/personal/SKILL.md",
    }, context(root))).content[0]?.text)).toContain("Personal skill");
    expect(String((await registry.execute("read", { path: artifactPath }, context(root))).content[0]?.text))
      .toContain("artifact text");

    const listed = await registry.execute("ls", { path: skillRoot }, context(root));
    expect(String(listed.content[0]?.text)).toContain("d references");
    const found = await registry.execute("find", {
      pattern: "*.md",
      path: repositorySkillsRoot,
    }, context(root));
    expect(String(found.content[0]?.text).replaceAll("\\", "/")).toContain(skillPath.replaceAll("\\", "/"));
    const grepped = await registry.execute("grep", {
      pattern: "Bundled skill",
      path: repositorySkillsRoot,
      output_mode: "content",
    }, context(root));
    expect(String(grepped.content[0]?.text).replaceAll("\\", "/")).toContain(skillPath.replaceAll("\\", "/"));

    expect((await registry.execute("send_file", { path: assetPath }, context(root))).files).toEqual([assetPath]);
    expect((await registry.execute("send_file", { path: artifactPath }, context(root))).files).toEqual([artifactPath]);
    await expect(registry.execute("send_file", { path: skillPath }, context(root))).rejects.toThrow("skill assets");
    await expect(registry.execute("read", { path: outsidePath }, context(root))).rejects.toThrow("approved read-only roots");
    await expect(registry.execute("read", {
      path: join(skillRoot, "escaped", "secret.txt"),
    }, context(root))).rejects.toThrow("approved read-only roots");
    await expect(registry.execute("write", {
      file_path: join(skillRoot, "new.txt"),
      content: "denied",
    }, context(root))).rejects.toThrow("escapes workspace");
    await expect(registry.execute("exec", {
      command: "echo denied",
      cwd: skillRoot,
    }, context(root))).rejects.toThrow("escapes workspace");
    await processes.stop();
  });

  test("rejects unavailable lxeskill commands before spawning without blocking other exec work", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-lxeskill-unavailable-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      lxeSkillStatus: () => ({
        state: "unavailable",
        available: false,
        message: "LXE Skill CLI is unavailable: No module named lxeskill",
        recovery: "run uv sync",
      }),
    });

    const ordinary = String((await registry.execute("exec", {
      command: "echo ordinary",
    }, context(root))).content[0]?.text);
    expect(ordinary).toContain("status: completed");
    expect(ordinary).toContain("ordinary");

    let failure: ToolExecutionError | undefined;
    try {
      await registry.execute("exec", { command: "lxeskill list" }, context(root));
    } catch (cause) {
      if (cause instanceof ToolExecutionError) failure = cause;
      else throw cause;
    }
    expect(failure?.code).toBe("environment_unavailable");
    expect(failure?.modelContent()).toContain('"retryable": false');
    expect(failure?.modelContent()).toContain("report_environment_failure_without_retrying_shell_variations");
    expect(processes.snapshots()).toHaveLength(1);
    await processes.stop();
  });

  test("exec sessions run cross-platform shell commands and lxeskill without PowerShell on Unix", async () => {
    const root = projectRoot;
    mkdirSync(join(projectRoot, "var", "tmp"), { recursive: true });
    const cwd = mkdtempSync(join(projectRoot, "var", "tmp", "exec 中文 (space)-"));
    roots.push(cwd);
    const registry = new ToolRegistry();
    const completed: JsonObject[] = [];
    const consumed: ProcessCompletionConsumeRequest[] = [];
    const processes = registerCodingTools(registry, {
      onProcessComplete: async (snapshot) => { completed.push(snapshot); },
      onProcessConsume: async (request) => { consumed.push(request); },
    });
    const started = await registry.execute("exec", {
      command: "python -c \"import time; time.sleep(0.08); print('done')\"",
      cwd,
      background: true,
    }, context(root));
    const startedText = String(started.content[0]?.text);
    expect(startedText).toContain("status: running");
    const session = startedText.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
    expect(session).toMatch(/^exec_/);
    if (!session) throw new Error(`missing process session in: ${startedText}`);
    const listed = String((await registry.execute("process", { action: "list" }, context(root))).content[0]?.text);
    expect(listed).toContain(String(session));
    await Bun.sleep(180);
    const polled = String((await registry.execute("process", { action: "poll", session }, context(root))).content[0]?.text);
    expect(polled).toContain("status: completed");
    expect(polled).toContain("done");
    expect(completed).toEqual([expect.objectContaining({
      session,
      status: "completed",
      origin_turn_id: "turn-1",
    })]);
    expect(consumed).toEqual([expect.objectContaining({
      task_id: session,
      status: "completed",
      reason: "process.poll",
    })]);
    await registry.execute("process", { action: "remove", session }, context(root));
    expect(consumed).toHaveLength(1);
    expect(processes.snapshots()).toHaveLength(0);

    const completedText = String((await registry.execute("exec", {
      command: "python -c \"print('x' * 3000)\"",
    }, context(root))).content[0]?.text);
    expect(completedText).toContain("status: completed");
    expect(completedText).toContain("output:");
    expect(completedText.length).toBeGreaterThan(2_000);

    const failed = String((await registry.execute("exec", {
      command: "python -c \"import sys; print('expected failure', file=sys.stderr); raise SystemExit(3)\"",
    }, context(root))).content[0]?.text);
    expect(failed).toContain("status: failed");
    expect(failed).toContain("expected failure");

    // Commands outside the attribution map still run: the CLI owns
    // authorization and list is always known to it.
    const lxeskillList = String((await registry.execute("exec", {
      command: "lxeskill list",
    }, context(root))).content[0]?.text);
    expect(lxeskillList).toContain("status: completed");
    await processes.stop();
  }, 15_000);

  test("consumes terminal background sessions once across log, kill, remove, and concurrent reads", async () => {
    const registry = new ToolRegistry();
    const consumed: ProcessCompletionConsumeRequest[] = [];
    const processes = registerCodingTools(registry, {
      onProcessConsume: async (request) => { consumed.push(request); },
    });
    const start = async (command: string): Promise<string> => {
      const result = String((await registry.execute("exec", { command, background: true }, context())).content[0]?.text);
      const session = result.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
      if (!session) throw new Error(`missing process session in: ${result}`);
      return session;
    };
    const waitFor = async (session: string, predicate: (snapshot: JsonObject) => boolean): Promise<void> => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const snapshot = processes.snapshots().find((item) => item.task_id === session);
        if (snapshot && predicate(snapshot)) return;
        await Bun.sleep(20);
      }
      throw new Error(`timed out waiting for process ${session}`);
    };

    const logged = await start("python -c \"print('logged')\"");
    await waitFor(logged, (snapshot) => snapshot.status !== "running");
    await processes.process({ action: "log", session: logged }, "s1");
    await processes.process({ action: "poll", session: logged }, "s1");
    expect(consumed.filter((item) => item.task_id === logged)).toEqual([
      expect.objectContaining({ reason: "process.log" }),
    ]);

    const removed = await start("python -c \"print('removed')\"");
    await waitFor(removed, (snapshot) => snapshot.status !== "running");
    await processes.process({ action: "remove", session: removed }, "s1");
    expect(consumed.filter((item) => item.task_id === removed)).toEqual([
      expect.objectContaining({ reason: "process.remove" }),
    ]);

    const killed = await start("python -c \"import time; print('ready', flush=True); time.sleep(60)\"");
    await waitFor(killed, (snapshot) => String(snapshot.output_tail ?? "").includes("ready"));
    await processes.process({ action: "list" }, "s1");
    expect((await processes.process({ action: "poll", session: killed }, "s1")).status).toBe("running");
    expect(consumed.some((item) => item.task_id === killed)).toBe(false);
    await processes.process({ action: "kill", session: killed }, "s1");
    expect(consumed.filter((item) => item.task_id === killed)).toEqual([
      expect.objectContaining({ reason: "process.kill", status: "killed" }),
    ]);

    const concurrent = await start("python -c \"print('concurrent')\"");
    await waitFor(concurrent, (snapshot) => snapshot.status !== "running");
    await Promise.all([
      processes.process({ action: "poll", session: concurrent }, "s1"),
      processes.process({ action: "log", session: concurrent }, "s1"),
    ]);
    expect(consumed.filter((item) => item.task_id === concurrent)).toHaveLength(1);

    await processes.stop();
  }, 15_000);

  test("preserves terminal output and retries when completion consumption fails", async () => {
    const registry = new ToolRegistry();
    let attempts = 0;
    let failNext = true;
    const processes = registerCodingTools(registry, {
      onProcessConsume: async () => {
        attempts += 1;
        if (failNext) {
          failNext = false;
          throw new Error("consume failed");
        }
      },
    });
    const started = String((await registry.execute("exec", {
      command: "python -c \"print('retry-output')\"",
      background: true,
    }, context())).content[0]?.text);
    const session = started.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
    if (!session) throw new Error(`missing process session in: ${started}`);
    const deadline = performance.now() + 5_000;
    while (processes.snapshots().find((item) => item.task_id === session)?.status === "running") {
      if (performance.now() >= deadline) throw new Error(`timed out waiting for process ${session}`);
      await Bun.sleep(20);
    }

    await expect(processes.process({ action: "poll", session }, "s1")).rejects.toThrow("consume failed");
    expect(attempts).toBe(1);
    expect((await processes.process({ action: "poll", session }, "s1")).new_output).toContain("retry-output");
    expect(attempts).toBe(2);

    const removable = String((await registry.execute("exec", {
      command: "python -c \"print('remove-retry')\"",
      background: true,
    }, context())).content[0]?.text).match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
    if (!removable) throw new Error("missing removable process session");
    const removeDeadline = performance.now() + 5_000;
    while (processes.snapshots().find((item) => item.task_id === removable)?.status === "running") {
      if (performance.now() >= removeDeadline) throw new Error(`timed out waiting for process ${removable}`);
      await Bun.sleep(20);
    }
    failNext = true;
    await expect(processes.process({ action: "remove", session: removable }, "s1")).rejects.toThrow("consume failed");
    expect(processes.snapshots().some((item) => item.task_id === removable)).toBe(true);
    await processes.process({ action: "remove", session: removable }, "s1");
    expect(processes.snapshots().some((item) => item.task_id === removable)).toBe(false);
    await processes.stop();
  }, 15_000);

  test("waits for completion notification persistence before consuming the event", async () => {
    const registry = new ToolRegistry();
    const order: string[] = [];
    let releaseNotification!: () => void;
    const notificationBlocked = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const processes = registerCodingTools(registry, {
      onProcessComplete: async () => {
        order.push("notification-started");
        await notificationBlocked;
        order.push("notification-persisted");
      },
      onProcessConsume: async () => { order.push("consumed"); },
    });
    const started = String((await registry.execute("exec", {
      command: "python -c \"print('race')\"",
      background: true,
    }, context())).content[0]?.text);
    const session = started.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
    if (!session) throw new Error(`missing process session in: ${started}`);
    const deadline = performance.now() + 5_000;
    while (!order.includes("notification-started")) {
      if (performance.now() >= deadline) throw new Error("completion notification did not start");
      await Bun.sleep(20);
    }

    const poll = processes.process({ action: "poll", session }, "s1");
    await Bun.sleep(20);
    expect(order).toEqual(["notification-started"]);
    releaseNotification();
    await poll;
    expect(order).toEqual(["notification-started", "notification-persisted", "consumed"]);
    await processes.stop();
  }, 15_000);

  test("exec forwards host env so lxeskill enforces the injected skill scope", async () => {
    const root = projectRoot;
    const registry = new ToolRegistry();
    const receivedSkillNames: Array<readonly string[]> = [];
    const processes = registerCodingTools(registry, {
      execEnv: ({ skillNames }) => {
        receivedSkillNames.push(skillNames);
        return { LXESKILL_SKILL_SCOPE: skillNames.join(",") };
      },
    });
    const listed = String((await registry.execute("exec", {
      command: "lxeskill list",
    }, { ...context(root), skill_names: ["replenishment-store-resolve"] })).content[0]?.text);
    expect(listed).toContain("replenish store resolve");
    expect(listed).not.toContain("fba customs fill");
    expect(listed).toContain("auth refresh");
    expect(receivedSkillNames).toEqual([["replenishment-store-resolve"]]);
    await processes.stop();
  });

  test("terminates the complete exec process tree", async () => {
    const root = projectRoot;
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const startTree = async (): Promise<{ session: string; childPid: number }> => {
      const started = String((await registry.execute("exec", {
        command: "python -c \"import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(child.pid, flush=True); time.sleep(60)\"",
        background: true,
      }, context(root))).content[0]?.text);
      const session = started.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
      expect(session).toMatch(/^exec_/);
      let observed = started;
      const deadline = performance.now() + 3_000;
      while (session && !/(?:tail|output):\s*\d+/u.test(observed) && performance.now() < deadline) {
        await Bun.sleep(25);
        const logged = String((await registry.execute(
          "process",
          { action: "log", session, offset: 1, limit: 10 },
          context(root),
        )).content[0]?.text);
        observed = `${started}\n${logged}`;
      }
      const childPid = Number(observed.match(/(?:tail|output):\s*(\d+)/u)?.[1]);
      expect(childPid).toBeGreaterThan(0);
      if (!session || !childPid) throw new Error(`missing process identifiers in: ${observed}`);
      return { session, childPid };
    };
    const expectDead = async (pid: number): Promise<void> => {
      let alive = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { process.kill(pid, 0); } catch { alive = false; break; }
        await Bun.sleep(50);
      }
      expect(alive).toBe(false);
    };

    const killed = await startTree();
    await registry.execute("process", { action: "kill", session: killed.session }, context(root));
    await expectDead(killed.childPid);

    const forceKilled = await startTree();
    await processes.stop();
    await expectDead(forceKilled.childPid);
  }, 15_000);

  test("uses timeout seconds and ignores the timer for explicit background work", async () => {
    const root = projectRoot;
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const timedOut = String((await registry.execute("exec", {
      command: "python -c \"import time; time.sleep(60)\"",
      timeout: 1,
      yield_ms: 2_000,
    }, context(root))).content[0]?.text);
    expect(timedOut).toContain("status: timeout");

    const background = String((await registry.execute("exec", {
      command: "python -c \"import time; time.sleep(0.05); print('background done')\"",
      timeout: 1,
      background: true,
    }, context(root))).content[0]?.text);
    const session = background.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
    expect(session).toMatch(/^exec_/);
    await Bun.sleep(100);
    const polled = session
      ? String((await registry.execute("process", { action: "poll", session }, context(root))).content[0]?.text)
      : "";
    expect(polled).toContain("status: completed");
    expect(polled).toContain("background done");

    const controller = new AbortController();
    const cancellation = registry.execute("exec", {
      command: "python -c \"import time; time.sleep(60)\"",
      timeout: 10,
      yield_ms: 2_000,
    }, {
      ...context(root),
      handle: {
        signal: controller.signal,
        cancelled: false,
        drainSteering: () => [],
        registerProcess: () => () => undefined,
      },
    });
    await Bun.sleep(100);
    controller.abort();
    expect(String((await cancellation).content[0]?.text)).toContain("status: killed");
    await processes.stop();
  }, 15_000);

  test("requires a current read before modifying existing files and protects runtime state", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-safety-"));
    roots.push(root);
    writeFileSync(join(root, "existing.txt"), "v1\n", "utf8");
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    await expect(registry.execute("edit", {
      file_path: "existing.txt", old_string: "v1", new_string: "v2",
    }, context(root))).rejects.toThrow("先用 read");
    await registry.execute("read", { path: "existing.txt" }, context(root));
    writeFileSync(join(root, "existing.txt"), "external\n", "utf8");
    await expect(registry.execute("write", {
      file_path: "existing.txt", content: "blind overwrite\n",
    }, context(root))).rejects.toThrow("重新 read");
    await expect(registry.execute("write", { file_path: ".env", content: "SECRET=x" }, context(root)))
      .rejects.toThrow("protected");
    await expect(registry.execute("write", {
      file_path: "var/db/sessions.json", content: "{}",
    }, context(root))).rejects.toThrow("protected");
    await expect(registry.execute("write", {
      file_path: "var/logs/runtime/x.log", content: "{}",
    }, context(root))).rejects.toThrow("protected");
    await processes.stop();
  });

  test("reads images by content instead of extension and reports coordinate scaling", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-image-"));
    roots.push(root);
    writeFileSync(join(root, "screenshot.data"), onePixelPng());
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const result = await registry.execute("read", { path: "screenshot.data" }, context(root));
    expect(result.content[0]?.text).toContain("Read image file [image/png]");
    expect(result.content[0]?.text).toContain("Multiply coordinates");
    expect(result.content[1]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    await processes.stop();
  });

  test("rejects unknown-extension binary files by content", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-binary-"));
    roots.push(root);
    writeFileSync(join(root, "payload.unknown"), new Uint8Array([1, 2, 0, 3, 4]));
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, { ripgrepPath: null });
    await expect(registry.execute("read", { path: "payload.unknown" }, context(root))).rejects.toThrow("binary file");
    await processes.stop();
  });

  test("reads a range from a large file without scanning to EOF", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-large-read-"));
    roots.push(root);
    // ~2 MiB file (well above the 512 KiB small-file threshold), 20k lines.
    const big = Array.from({ length: 20_000 }, (_unused, index) => `line-${index + 1} ${"x".repeat(90)}`).join("\n");
    writeFileSync(join(root, "big.txt"), `${big}\n`);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});

    const ranged = await registry.execute("read", { path: "big.txt", offset: 100, limit: 3 }, context(root));
    const text = ranged.content[0]?.text ?? "";
    expect(text).toContain("   100\tline-100");
    expect(text).toContain("   102\tline-102");
    expect(text).not.toContain("line-103");
    expect(text).not.toContain("line-1 ");

    // A default read (no limit) must page rather than dump the whole file.
    const capped = await registry.execute("read", { path: "big.txt" }, context(root));
    const cappedText = String(capped.content[0]?.text ?? "");
    const nextOffset = Number(cappedText.match(/使用 offset=(\d+) 继续/u)?.[1] ?? 0);
    expect(nextOffset).toBeGreaterThan(1);
    expect(cappedText).toContain(`${String(nextOffset - 1).padStart(6, " ")}\tline-${nextOffset - 1} ${"x".repeat(90)}`);
    await processes.stop();
  });

  test("bounds a giant text line and does not offer a misleading next-line offset", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-giant-line-"));
    roots.push(root);
    writeFileSync(join(root, "giant.txt"), "中".repeat(2 * 1024 * 1024));
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});

    const result = await registry.execute("read", { path: "giant.txt" }, context(root));
    const output = String(result.content[0]?.text ?? "");
    expect(output.length).toBeLessThanOrEqual(10_000);
    expect(output).toContain("第 1 行超过 10000 字符读取上限");
    expect(output).not.toContain("使用 offset=");
    await processes.stop();
  });

  test("does not authorize edits when a file changes during an asynchronous read", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-read-race-"));
    roots.push(root);
    const path = join(root, "changing.txt");
    writeFileSync(path, "old\n".repeat(2_000_000));
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const mutation = setInterval(() => appendFileSync(path, "changed\n"), 1);
    try {
      await expect(registry.execute("read", {
        path: "changing.txt",
        offset: 1_999_999,
        limit: 1,
      }, context(root))).rejects.toThrow("read 期间文件发生变化");
    } finally {
      clearInterval(mutation);
    }
    await expect(registry.execute("edit", {
      file_path: "changing.txt",
      old_string: "old",
      new_string: "new",
      replace_all: true,
    }, context(root))).rejects.toThrow("请先用 read");
    await processes.stop();
  });

  test("honors an already-cancelled read without recording a ledger version", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-read-abort-"));
    roots.push(root);
    writeFileSync(join(root, "cancelled.txt"), "content\n");
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(registry.execute("read", { path: "cancelled.txt" }, context(root, controller))).rejects.toThrow("cancelled");
    await expect(registry.execute("edit", {
      file_path: "cancelled.txt", old_string: "content", new_string: "changed",
    }, context(root))).rejects.toThrow("请先用 read");
    await processes.stop();
  });

  test("restores grep modes, find ordering, send boundaries, and business CLI guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-contract-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      businessCommands: new Map([
        ["lxeskill replenish store resolve", ["replenishment-store-resolve"]],
        ["lxeskill fba shipment delivery-csv-download", ["fba-shipment-delivery-csv-download"]],
      ]),
      businessCommandCatalog: [
        {
          command: "lxeskill replenish store resolve",
          module: "services.agent_cli.mabang.resolve_fba_store",
          ownerSkills: ["replenishment-store-resolve"],
        },
        {
          command: "lxeskill fba shipment delivery-csv-download",
          module: "services.agent_cli.mabang.download_fba_delivery_csv",
          ownerSkills: ["fba-shipment-delivery-csv-download"],
        },
      ],
    });
    await registry.execute("write", { file_path: "src/a.py", content: "alpha\nbeta\nbeta\n" }, context(root));
    const count = await registry.execute("grep", {
      pattern: "beta", path: "src", output_mode: "count", type: "py",
    }, context(root));
    expect(String(count.content[0]?.text).replaceAll("\\", "/")).toContain("src/a.py:2");
    await expect(registry.execute("send_file", { path: "src/a.py" }, context(root))).rejects.toThrow("artifacts");
    await registry.execute("write", { file_path: "artifacts/a.txt", content: "ok" }, context(root));
    expect((await registry.execute("send_file", { path: "artifacts/a.txt" }, context(root))).files).toHaveLength(1);
    const rejected = async (
      command: string,
      executionContext: Parameters<ToolRegistry["execute"]>[2] = context(root),
    ): Promise<ToolExecutionError> => {
      try {
        await registry.execute("exec", { command }, executionContext);
      } catch (error) {
        expect(error).toBeInstanceOf(ToolExecutionError);
        return error as ToolExecutionError;
      }
      throw new Error(`expected command to be rejected: ${command}`);
    };
    const directModule = await rejected("python -m services.agent_cli.mabang.resolve_fba_store");
    expect(directModule.code).toBe("permission_denied");
    expect(directModule.recoveryGroup).toBe("lxeskill_invocation");
    expect(directModule.details).toMatchObject({
      type: "lxeskill_invocation_error",
      violations: ["direct_business_module"],
      canonical_command_path: "lxeskill replenish store resolve",
      owner_skills: ["replenishment-store-resolve"],
      describe_command: "lxeskill describe replenish store resolve",
    });
    const deliveryModule = await rejected("python -m services.agent_cli.mabang.download_fba_delivery_csv");
    expect(deliveryModule.details).toMatchObject({
      canonical_command_path: "lxeskill fba shipment delivery-csv-download",
      owner_skills: ["fba-shipment-delivery-csv-download"],
      describe_command: "lxeskill describe fba shipment delivery-csv-download",
    });
    const pythonWrapper = await rejected("python -m lxeskill replenish store resolve");
    expect(pythonWrapper.code).toBe("permission_denied");
    expect(pythonWrapper.details).toMatchObject({ violations: ["python_module_wrapper", "not_standalone"] });
    const embedded = await rejected("echo lxeskill replenish store resolve");
    expect(embedded.code).toBe("unsupported_invocation");
    expect(embedded.details).toMatchObject({ violations: ["not_standalone"] });
    expect((await rejected("lxeskill replenish store resolve && echo done")).details)
      .toMatchObject({ violations: ["shell_composition"] });
    expect((await rejected("lxeskill replenish store resolve > result.txt")).details)
      .toMatchObject({ violations: ["shell_composition"] });
    expect((await rejected("lxeskill replenish store resolve\necho done")).details)
      .toMatchObject({ violations: ["shell_composition"] });
    const polluted = await rejected(
      "cd /work && uv run --frozen lxeskill replenish store resolve --store-name Demo --token raw-secret 2>/dev/null | head || python -m services.agent_cli.mabang.resolve_fba_store",
    );
    expect(polluted.code).toBe("permission_denied");
    expect(polluted.details).toMatchObject({
      violations: ["direct_business_module", "not_standalone", "shell_composition"],
      canonical_command_path: "lxeskill replenish store resolve",
      owner_skills: ["replenishment-store-resolve"],
    });
    const recovery = polluted.modelContent(1);
    expect(recovery).toContain('"retryable": true');
    expect(recovery).not.toContain("raw-secret");
    expect(recovery).not.toContain("/work");
    const unknownLegacy = await rejected("python -m services.agent_cli.mabang.removed_old_module");
    expect(unknownLegacy.details).toMatchObject({ discovery_command: "lxeskill list" });
    const hiddenSkills = registry.createExposureState({ allowedSkills: new Set(["another-skill"]) });
    const hiddenCommand = await rejected(
      "python -m services.agent_cli.mabang.download_fba_delivery_csv",
      { ...context(root), exposureState: hiddenSkills },
    );
    expect(hiddenCommand.details).toMatchObject({ discovery_command: "lxeskill list" });
    expect(hiddenCommand.modelContent(1)).not.toContain("fba-shipment-delivery-csv-download");
    // Unknown commands pass through: authorization belongs to the CLI, which
    // rejects them with a structured error. Here the temp root has neither a
    // managed Python nor .venv, so normalization fails before any spawn.
    await expect(registry.execute("exec", {
      command: "lxeskill unknown command",
    }, context(root))).rejects.toThrow("project Python is unavailable");
    await expect(registry.execute("exec", {
      command: "lxeskill.cmd unknown command",
    }, context(root))).rejects.toThrow("project Python is unavailable");
    const classified = registry.definition("exec")?.classifyInvocation?.({
      command: "lxeskill replenish store resolve --store-name Demo --token secret",
    });
    expect(classified).toEqual({
      usageName: "lxeskill:replenish store resolve",
      commandId: "replenish store resolve",
      ownerSkills: ["replenishment-store-resolve"],
    });
    await expect(registry.execute("exec", {
      command: "lxeskill replenish store resolve",
      timeout: 120_000,
    }, context(root))).rejects.toThrow("between 1 and 3600 seconds");
    expect(registry.definition("exec")?.input_schema.properties).toMatchObject({
      command: { description: expect.stringContaining("exactly one standalone") },
      timeout: { type: "number", minimum: 1, maximum: 3_600, default: 120 },
      yield_ms: { type: "number", minimum: 1, default: 10_000 },
    });
    await processes.stop();
  });

  test("tool search discovers tools by name, description, and parameters", async () => {
    const root = projectRoot;
    const registry = new ToolRegistry();
    registry.register({ name: "inventory_lookup", description: "Find stock by SKU", input_schema: { type: "object", properties: { sku: { type: "string" } } }, execute: async () => ({ content: [] }) });
    registerToolSearch(registry);
    const found = await registry.execute("tool_search", { query: "stock sku" }, context(root));
    expect(JSON.parse(String(found.content[0]?.text)).tools).toEqual([expect.objectContaining({ name: "inventory_lookup" })]);
  });
});
