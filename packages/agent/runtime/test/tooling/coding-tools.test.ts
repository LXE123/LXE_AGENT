import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { JsonObject } from "@lxe/protocol";
import { repositoryRoot } from "@lxe/core";
import { registerCodingTools } from "../../src/tooling/coding-tools";
import { ToolExecutionError, ToolRegistry } from "../../src/tooling/registry";
import { registerToolSearch } from "../../src/tooling/tool-search";
import type { WorkspaceSearchService } from "../../src/tooling/workspace-search";
import { removeTemporaryRoot } from "../temp-directory";
import { workspaceFor } from "../workspace";

const roots: string[] = [];
const projectRoot = repositoryRoot(import.meta.dir);
const evalCommand = (source: string): string => {
  const executable = `"${process.execPath}"`;
  return `${process.platform === "win32" ? "& " : ""}${executable} -e "${source}"`;
};
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

const context = (workspaceRoot: string = projectRoot, controller = new AbortController()) => ({
  session_id: "s1",
  turn_id: "turn-1",
  response_route_id: "route-1",
  tool_call_id: "tool-exec-1",
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
  test("isolates two session workspaces and yielded execs from the process cwd", async () => {
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
        command: evalCommand("console.log(process.cwd())"),
      }, contextA);
      expect(String(cwdResult.content[0]?.text).replaceAll("\\", "/"))
        .toContain(realpathSync.native(directoryA).replaceAll("\\", "/"));

      const started = await registry.execute("exec", {
        command: evalCommand("setTimeout(() => {}, 60000)"),
        "yield-time-ms": 250,
      }, contextA);
      const processId = String(started.content[0]?.text).match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
      expect(processId).toMatch(/^exec_/);
      if (!processId) throw new Error("missing background process id");
      expect(String((await registry.execute("wait", { exec_id: processId, terminate: true }, contextB)).content[0]?.text))
        .toContain("不存在");
      await registry.execute("wait", { exec_id: processId, terminate: true }, contextA);
    } finally {
      process.chdir(previousCwd);
      await processes.stop();
    }
  }, 30_000);

  test("exposes compatible coding schemas and keeps file operations inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      businessCommands: new Map([["lxeskill replenish store resolve", ["replenishment-store-resolve"]]]),
    });
    expect(registry.schemas().map((item) => item.name)).toEqual([
      "read", "write", "edit", "grep", "find", "ls", "send_files", "exec", "wait",
    ]);
    expect(registry.definition("exec")?.supportsParallelCalls).toBe(true);
    expect(registry.definition("wait")?.supportsParallelCalls).toBe(true);
    for (const name of ["exec", "wait"]) {
      const properties = registry.definition(name)?.input_schema.properties as JsonObject | undefined;
      expect(properties?.["max-output-tokens"]).toEqual({
        type: "integer",
        minimum: 1,
        maximum: 10_000,
        default: 10_000,
        description: expect.stringContaining("model-visible"),
      });
    }
    for (const name of ["read", "write", "edit", "grep", "find", "ls", "send_files"]) {
      expect(registry.definition(name)?.supportsParallelCalls).not.toBe(true);
    }
    expect(registry.definition("send_file")).toBeUndefined();
    expect(registry.definition("send_files")?.input_schema).toEqual({
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          uniqueItems: true,
        },
      },
      required: ["paths"],
      additionalProperties: false,
    });
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

  test("validates the exec and wait observation token budget", async () => {
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    for (const value of [0, 10_001, 1.5, Number.NaN]) {
      await expect(registry.execute("exec", {
        command: "echo never",
        "max-output-tokens": value,
      }, context())).rejects.toThrow("max-output-tokens must be an integer between 1 and 10000");
      await expect(registry.execute("wait", {
        exec_id: "exec_missing",
        "max-output-tokens": value,
      }, context())).rejects.toThrow("max-output-tokens must be an integer between 1 and 10000");
    }
    await processes.stop();
  });

  test("uses the search service supplied by the active workspace lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-search-lease-"));
    roots.push(root);
    const calls: string[] = [];
    const workspaceSearch = {
      grep: async () => { calls.push("grep"); return "lease grep"; },
      find: async () => { calls.push("find"); return "lease find"; },
    } as unknown as WorkspaceSearchService;
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const leasedContext = { ...context(root), workspaceSearch };
    expect((await registry.execute("grep", { pattern: "x" }, leasedContext)).content[0]?.text)
      .toContain("lease grep");
    expect((await registry.execute("find", { pattern: "*" }, leasedContext)).content[0]?.text)
      .toContain("lease find");
    expect(calls).toEqual(["grep", "find"]);
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
      userSkillsRoot: join(home, ".agents", "skills"),
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

    const sent = await registry.execute("send_files", {
      paths: [assetPath, artifactPath, `${artifactRoot}/nested/../report.txt`],
    }, context(root));
    expect(sent.files).toEqual([assetPath, artifactPath]);
    const sentText = String(sent.content[0]?.text).replaceAll("\\", "/");
    expect(sentText).toContain("Sent 2 files:");
    expect(sentText).toContain(assetPath.replaceAll("\\", "/"));
    expect(sentText).toContain(artifactPath.replaceAll("\\", "/"));
    await expect(registry.execute("send_files", { paths: [artifactPath, skillPath] }, context(root)))
      .rejects.toThrow("skill assets");
    await expect(registry.execute("send_files", {
      paths: [artifactPath, join(artifactRoot, "missing.txt")],
    }, context(root))).rejects.toThrow("file not found");
    await expect(registry.execute("send_files", { paths: [] }, context(root)))
      .rejects.toThrow("non-empty array");
    await expect(registry.execute("send_files", { paths: [artifactPath, ""] }, context(root)))
      .rejects.toThrow("paths[1]");
    await expect(registry.execute("send_files", { path: artifactPath }, context(root)))
      .rejects.toThrow("non-empty array");
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

  test("reads only the exact regular files attached to the current session", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lxe-attachment-workspace-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "lxe-attachment-external-"));
    roots.push(workspaceRoot, externalRoot);
    const attached = join(externalRoot, "selected.txt");
    const adjacent = join(externalRoot, "private.txt");
    writeFileSync(attached, "selected content", "utf8");
    writeFileSync(adjacent, "private content", "utf8");
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      attachmentPaths: async (sessionId) => sessionId === "s1" ? [attached] : [],
    });
    try {
      const read = await registry.execute("read", { path: attached }, context(workspaceRoot));
      expect(read.content[0]?.text).toContain("selected content");
      await expect(registry.execute("read", { path: externalRoot }, context(workspaceRoot)))
        .rejects.toThrow("escapes workspace");
      await expect(registry.execute("read", { path: adjacent }, context(workspaceRoot)))
        .rejects.toThrow("escapes workspace");
      await expect(registry.execute("read", { path: attached }, { ...context(workspaceRoot), session_id: "s2" }))
        .rejects.toThrow("escapes workspace");
      await expect(registry.execute("write", { file_path: attached, content: "changed" }, context(workspaceRoot)))
        .rejects.toThrow("escapes workspace");
      await expect(registry.execute("send_files", { paths: [attached] }, context(workspaceRoot)))
        .rejects.toThrow("escapes workspace");

      rmSync(attached);
      symlinkSync(adjacent, attached);
      await expect(registry.execute("read", { path: attached }, context(workspaceRoot)))
        .rejects.toThrow("not a regular file");
      await expect(registry.execute("read", { path: adjacent }, context(workspaceRoot)))
        .rejects.toThrow("escapes workspace");
    } finally {
      await processes.stop();
    }
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

  test("exec yields to a session-owned wait and emits one UI-only completion snapshot", async () => {
    const root = projectRoot;
    mkdirSync(join(projectRoot, "var", "tmp"), { recursive: true });
    const cwd = mkdtempSync(join(projectRoot, "var", "tmp", "exec 中文 (space)-"));
    roots.push(cwd);
    const registry = new ToolRegistry();
    const completed: JsonObject[] = [];
    const processes = registerCodingTools(registry, {
      onExecComplete: async (snapshot) => { completed.push(snapshot); },
    });
    const started = await registry.execute("exec", {
      command: "python -c \"import time; print('started', flush=True); time.sleep(0.35); print('done')\"",
      cwd,
      "yield-time-ms": 250,
    }, context(root));
    const startedText = String(started.content[0]?.text);
    expect(startedText).toContain("status: running");
    expect(started.display_status).toBe("running");
    const execId = startedText.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
    expect(execId).toMatch(/^exec_/);
    if (!execId) throw new Error(`missing exec id in: ${startedText}`);
    const polled = String((await registry.execute("wait", { exec_id: execId }, {
      ...context(root),
      turn_id: "turn-2",
      tool_call_id: "tool-wait-1",
    })).content[0]?.text);
    expect(polled).toContain("status: completed");
    expect(polled).toContain("done");
    expect(completed).toEqual([expect.objectContaining({
      exec_id: execId,
      status: "completed",
      origin_turn_id: "turn-1",
      tool_call_id: "tool-exec-1",
    })]);
    expect(String((await registry.execute("wait", { exec_id: execId }, context(root))).content[0]?.text))
      .toContain("已经关闭");

    const completedText = String((await registry.execute("exec", {
      command: "python -c \"print('x' * 3000)\"",
    }, context(root))).content[0]?.text);
    expect(completedText).toContain("status: completed");
    expect(completedText).toContain("output:");
    expect(completedText.length).toBeGreaterThan(2_000);
    expect(completedText).not.toContain("output_path:");

    const budgeted = String((await registry.execute("exec", {
      command: "python -c \"print('BEGIN-' + 'x' * 6000 + '-END')\"",
      "max-output-tokens": 100,
    }, context(root))).content[0]?.text);
    expect(budgeted).toContain("status: completed");
    expect(budgeted).toContain("observation_truncated: true");
    expect(budgeted).toContain("observation_original_tokens:");
    expect(budgeted).toContain("observation_omitted_tokens:");
    expect(budgeted).toContain("output_file_covers_captured: true");
    expect(budgeted).toContain("output_file_truncated: false");
    expect(budgeted).toContain("BEGIN-");
    expect(budgeted).toContain("-END");
    const budgetedPath = budgeted.match(/^output_path: (.+)$/mu)?.[1];
    if (!budgetedPath) throw new Error(`missing budgeted output_path in: ${budgeted}`);
    expect(readFileSync(budgetedPath, "utf8")).toContain(`BEGIN-${"x".repeat(6000)}-END`);

    const failedResult = await registry.execute("exec", {
      command: "python -c \"import sys; print('expected failure', file=sys.stderr); raise SystemExit(3)\"",
    }, context(root));
    const failed = String(failedResult.content[0]?.text);
    expect(failed).toContain("status: failed");
    expect(failed).toContain("expected failure");
    expect(failedResult.display_status).toBe("error");

    // Output past the in-context limit keeps its END (where failures land) and the
    // full transcript stays reachable on disk.
    const oversized = String((await registry.execute("exec", {
      command: "python -c \"[print(f'第 {i} 行 构建输出') for i in range(6000)]; print('最终失败：缺少依赖')\"",
    }, context(root))).content[0]?.text);
    expect(oversized).toContain("status: completed");
    expect(oversized).toContain("truncated: true");
    expect(oversized).toContain("observation_truncated: true");
    expect(oversized).toContain("output_file_covers_captured: true");
    expect(oversized).toContain("output_file_truncated: false");
    expect(oversized).toContain("最终失败：缺少依赖");
    expect(oversized).not.toContain("第 0 行");
    expect(oversized).not.toContain("�");
    expect(Buffer.byteLength(oversized, "utf8")).toBeLessThanOrEqual(40_000);
    const spillPath = oversized.match(/^output_path: (.+)$/mu)?.[1];
    if (!spillPath) throw new Error(`missing output_path in: ${oversized.slice(0, 400)}`);
    const transcript = readFileSync(spillPath, "utf8");
    expect(transcript).toContain("第 0 行 构建输出");
    expect(transcript.trimEnd().endsWith("最终失败：缺少依赖")).toBe(true);

    // Interleaved streams keep their real order instead of being split into blocks.
    const interleaved = String((await registry.execute("exec", {
      command: "python -c \"import sys; print('step 1'); print('warn', file=sys.stderr); sys.stderr.flush(); print('step 2')\"",
    }, context(root))).content[0]?.text);
    expect(interleaved).toContain("[stderr]");
    expect(interleaved).toContain("warn");
    expect(interleaved).toContain("step 2");

    // Commands outside the attribution map still run: the CLI owns
    // authorization and list is always known to it.
    const lxeskillList = String((await registry.execute("exec", {
      command: "lxeskill list",
    }, context(root))).content[0]?.text);
    expect(lxeskillList).toContain("status: completed");
    await processes.stop();
  }, 30_000);

  test("token-budget omission is recovered on disk without replaying the wait cursor", async () => {
    const root = projectRoot;
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const started = String((await registry.execute("exec", {
      command: "python -c \"import time; print('FIRST-' + 'x' * 6000, flush=True); time.sleep(0.5); print('SECOND', flush=True)\"",
      "yield-time-ms": 250,
      "max-output-tokens": 80,
    }, context(root))).content[0]?.text);
    expect(started).toContain("status: running");
    expect(started).toContain("observation_truncated: true");
    expect(started).toContain("FIRST-");
    const execId = started.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
    const outputPath = started.match(/^output_path: (.+)$/mu)?.[1];
    if (!execId || !outputPath) throw new Error(`missing budgeted running metadata in: ${started}`);

    const completed = String((await registry.execute("wait", {
      exec_id: execId,
      "max-output-tokens": 80,
    }, context(root))).content[0]?.text);
    expect(completed).toContain("status: completed");
    expect(completed).toContain("SECOND");
    expect(completed).not.toContain("FIRST-");
    const transcript = readFileSync(outputPath, "utf8");
    expect(transcript).toContain("FIRST-");
    expect(transcript.trimEnd().endsWith("SECOND")).toBe(true);
    await processes.stop();
  }, 30_000);

  test("wait batches output, serializes one exec, and closes it after the final observation", async () => {
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const start = async (command: string): Promise<string> => {
      const result = String((await registry.execute("exec", {
        command,
        "yield-time-ms": 250,
      }, context())).content[0]?.text);
      const session = result.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
      if (!session) throw new Error(`missing process session in: ${result}`);
      return session;
    };
    const waitFor = async (session: string, predicate: (snapshot: JsonObject) => boolean): Promise<void> => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const snapshot = processes.snapshots().find((item) => item.exec_id === session);
        if (snapshot && predicate(snapshot)) return;
        await Bun.sleep(20);
      }
      throw new Error(`timed out waiting for process ${session}`);
    };

    const polled = await start("python -c \"import time; time.sleep(0.3); print('polled')\"");
    await waitFor(polled, (snapshot) => snapshot.status !== "running");
    const polledFinal = await processes.wait({
      execId: polled, sessionId: "s1", yieldMs: 200, terminate: false,
      signal: new AbortController().signal,
    });
    expect(polledFinal.status).toBe("completed");
    expect((await processes.wait({
      execId: polled, sessionId: "s1", yieldMs: 200, terminate: false,
      signal: new AbortController().signal,
    })).error).toContain("已经关闭");

    const killed = await start("python -c \"import time; print('ready', flush=True); time.sleep(60)\"");
    await waitFor(killed, (snapshot) => String(snapshot.output_tail ?? "").includes("ready"));
    expect((await processes.wait({
      execId: killed, sessionId: "s1", yieldMs: 200, terminate: false,
      signal: new AbortController().signal,
    })).status).toBe("running");
    expect((await processes.wait({
      execId: killed, sessionId: "s1", yieldMs: 200, terminate: true,
      signal: new AbortController().signal,
    })).status).toBe("killed");

    // A running command holds the poll for the whole window even while it is printing:
    // returning on the first byte produced one-line polls instead of batched progress.
    const chatty = await start(
      "python -c \"import time\nfor i in range(20):\n    print('tick', i, flush=True)\n    time.sleep(0.02)\ntime.sleep(60)\"",
    );
    await waitFor(chatty, (snapshot) => String(snapshot.output_tail ?? "").includes("tick 0"));
    const chattyStart = performance.now();
    const chattyPoll = await processes.wait({
      execId: chatty, sessionId: "s1", yieldMs: 200, terminate: false,
      signal: new AbortController().signal,
    });
    const chattyElapsed = performance.now() - chattyStart;
    expect(chattyPoll.status).toBe("running");
    expect(chattyElapsed).toBeGreaterThanOrEqual(150);
    // The batched answer carries several ticks produced during the window, not just one.
    const observedTicks = [...String(chattyPoll.new_output).matchAll(/tick (\d+)/gu)]
      .map((match) => Number(match[1]));
    expect(observedTicks.length).toBeGreaterThanOrEqual(4);
    expect(observedTicks.at(-1)! - observedTicks[0]!).toBeGreaterThanOrEqual(3);
    await processes.wait({
      execId: chatty, sessionId: "s1", yieldMs: 200, terminate: true,
      signal: new AbortController().signal,
    });

    // Finishing still cuts the wait short, because nothing more can arrive.
    const brief = await start("python -c \"import time; time.sleep(0.3); print('brief')\"");
    const briefStart = performance.now();
    const briefPoll = await processes.wait({
      execId: brief, sessionId: "s1", yieldMs: 200, terminate: false,
      signal: new AbortController().signal,
    });
    expect(performance.now() - briefStart).toBeLessThan(150);
    expect(briefPoll.status).toBe("completed");

    const concurrent = await start("python -c \"import time; time.sleep(0.3); print('concurrent')\"");
    await waitFor(concurrent, (snapshot) => snapshot.status !== "running");
    const concurrentResults = await Promise.all([
      processes.wait({ execId: concurrent, sessionId: "s1", yieldMs: 200, terminate: false, signal: new AbortController().signal }),
      processes.wait({ execId: concurrent, sessionId: "s1", yieldMs: 200, terminate: false, signal: new AbortController().signal }),
    ]);
    expect(concurrentResults.filter((item) => item.status === "completed")).toHaveLength(1);
    expect(concurrentResults.filter((item) => typeof item.error === "string")).toHaveLength(1);
    expect(processes.snapshots().find((item) => item.exec_id === concurrent)?.status).toBe("completed");

    const parallelA = await start("python -c \"import time; time.sleep(60)\"");
    const parallelB = await start("python -c \"import time; time.sleep(60)\"");
    const parallelStarted = performance.now();
    const parallelResults = await Promise.all([parallelA, parallelB].map((execId) => processes.wait({
      execId, sessionId: "s1", yieldMs: 200, terminate: false,
      signal: new AbortController().signal,
    })));
    expect(performance.now() - parallelStarted).toBeLessThan(350);
    expect(parallelResults.map((item) => item.status)).toEqual(["running", "running"]);
    await Promise.all([parallelA, parallelB].map((execId) => processes.wait({
      execId, sessionId: "s1", yieldMs: 200, terminate: true,
      signal: new AbortController().signal,
    })));

    await processes.stop();
  }, 30_000);

  test("bounds inherited output-pipe draining and preserves a previously observed natural exit", async () => {
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const startWithInheritedPipe = async (childSleepSeconds: number): Promise<string> => {
      const result = String((await registry.execute("exec", {
        command: `python -c "import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(${childSleepSeconds})'], stdout=sys.stdout, stderr=sys.stderr); print('parent done', flush=True)"`,
        "yield-time-ms": 250,
      }, context())).content[0]?.text);
      const execId = result.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
      if (!execId) throw new Error(`missing process session in: ${result}`);
      return execId;
    };

    const draining = await startWithInheritedPipe(3);
    const drainStarted = performance.now();
    const drained = await processes.wait({
      execId: draining, sessionId: "s1", yieldMs: 5_000, terminate: false,
      signal: new AbortController().signal,
    });
    const drainElapsed = performance.now() - drainStarted;
    expect(drainElapsed).toBeGreaterThanOrEqual(1_500);
    expect(drainElapsed).toBeLessThan(3_500);
    expect(drained).toEqual(expect.objectContaining({
      status: "completed",
      output_incomplete: true,
      output_incomplete_reason: "stream_drain_timeout",
    }));
    expect(String(processes.snapshots().find((item) => item.exec_id === draining)?.output_tail))
      .toContain("parent done");

    const naturallyExited = await startWithInheritedPipe(1);
    const natural = await processes.wait({
      execId: naturallyExited, sessionId: "s1", yieldMs: 5_000, terminate: true,
      signal: new AbortController().signal,
    });
    expect(natural.status).toBe("completed");
    expect(natural.output_incomplete).toBeUndefined();
    await processes.stop();
  }, 15_000);

  test("terminate preempts queued observations and wakes an active long poll", async () => {
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const started = String((await registry.execute("exec", {
      command: "python -c \"import time; print('ready', flush=True); time.sleep(60)\"",
      "yield-time-ms": 250,
    }, context())).content[0]?.text);
    const execId = started.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
    if (!execId) throw new Error(`missing process session in: ${started}`);

    const order: string[] = [];
    const active = processes.wait({
      execId, sessionId: "s1", yieldMs: 300_000, terminate: false,
      signal: new AbortController().signal,
    }).then((result) => { order.push("active"); return result; });
    const queued = processes.wait({
      execId, sessionId: "s1", yieldMs: 300_000, terminate: false,
      signal: new AbortController().signal,
    }).then((result) => { order.push("queued"); return result; });
    await Bun.sleep(50);
    const terminateStarted = performance.now();
    const terminating = processes.wait({
      execId, sessionId: "s1", yieldMs: 300_000, terminate: true,
      signal: new AbortController().signal,
    }).then((result) => { order.push("terminate"); return result; });
    const [activeResult, queuedResult, terminateResult] = await Promise.all([active, queued, terminating]);
    expect(performance.now() - terminateStarted).toBeLessThan(5_000);
    expect(activeResult.status).toBe("killed");
    expect(terminateResult.status).toBe("killed");
    expect(queuedResult.error).toContain("已经关闭");
    expect(order).toEqual(["active", "terminate", "queued"]);
    await processes.stop();
  }, 15_000);

  test("preserves terminal output when the UI completion callback fails", async () => {
    const registry = new ToolRegistry();
    let attempts = 0;
    const processes = registerCodingTools(registry, {
      onExecComplete: async () => {
        attempts += 1;
        throw new Error("notification failed");
      },
    });
    const started = String((await registry.execute("exec", {
      command: "python -c \"import time; time.sleep(0.3); print('retry-output')\"",
      "yield-time-ms": 250,
    }, context())).content[0]?.text);
    const session = started.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
    if (!session) throw new Error(`missing process session in: ${started}`);
    const deadline = performance.now() + 5_000;
    while (processes.snapshots().find((item) => item.exec_id === session)?.status === "running") {
      if (performance.now() >= deadline) throw new Error(`timed out waiting for process ${session}`);
      await Bun.sleep(20);
    }

    const observed = await processes.wait({
      execId: session, sessionId: "s1", yieldMs: 200, terminate: false,
      signal: new AbortController().signal,
    });
    expect(attempts).toBe(1);
    expect(String(observed.new_output)).toContain("retry-output");
    await processes.stop();
  }, 30_000);

  test("emits completion only after exec has yielded", async () => {
    const registry = new ToolRegistry();
    const order: string[] = [];
    const processes = registerCodingTools(registry, {
      onExecComplete: async () => { order.push("completed"); },
    });
    const started = String((await registry.execute("exec", {
      command: "python -c \"import time; time.sleep(0.3); print('race')\"",
      "yield-time-ms": 250,
    }, context())).content[0]?.text);
    const session = started.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
    if (!session) throw new Error(`missing process session in: ${started}`);
    const deadline = performance.now() + 5_000;
    while (!order.includes("completed")) {
      if (performance.now() >= deadline) throw new Error("completion notification did not start");
      await Bun.sleep(20);
    }
    expect(order).toEqual(["completed"]);
    expect((await processes.wait({
      execId: session, sessionId: "s1", yieldMs: 200, terminate: false,
      signal: new AbortController().signal,
    })).status).toBe("completed");
    expect(order).toEqual(["completed"]);
    await processes.stop();
  }, 30_000);

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
    const startTree = async (): Promise<{ execId: string; childPid: number }> => {
      const started = String((await registry.execute("exec", {
        command: "python -c \"import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(child.pid, flush=True); time.sleep(60)\"",
        "yield-time-ms": 250,
      }, context(root))).content[0]?.text);
      const execId = started.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
      expect(execId).toMatch(/^exec_/);
      let observed = started;
      const deadline = performance.now() + 3_000;
      while (execId && !/(?:tail|output):\s*\d+/u.test(observed) && performance.now() < deadline) {
        await Bun.sleep(25);
        const logged = String((await processes.wait({
          execId, sessionId: "s1", yieldMs: 25, terminate: false,
          signal: new AbortController().signal,
        })).new_output ?? "");
        observed = `${started}\n${logged}`;
      }
      const childPid = Number(observed.match(/(?:tail|output):\s*(\d+)/u)?.[1]);
      expect(childPid).toBeGreaterThan(0);
      if (!execId || !childPid) throw new Error(`missing process identifiers in: ${observed}`);
      return { execId, childPid };
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
    await registry.execute("wait", { exec_id: killed.execId, terminate: true }, context(root));
    await expectDead(killed.childPid);

    const forceKilled = await startTree();
    await processes.stop();
    await expectDead(forceKilled.childPid);
  }, 30_000);

  test("turn cancellation detaches observation without killing the exec", async () => {
    const root = projectRoot;
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const controller = new AbortController();
    let processRegistered = false;
    const cancellation = registry.execute("exec", {
      command: "python -c \"import time; time.sleep(60)\"",
      "yield-time-ms": 2_000,
    }, {
      ...context(root),
      handle: {
        signal: controller.signal,
        cancelled: false,
        drainSteering: () => [],
        registerProcess: () => {
          processRegistered = true;
          return () => undefined;
        },
      },
    });
    await Bun.sleep(100);
    controller.abort();
    const detached = String((await cancellation).content[0]?.text);
    expect(detached).toContain("status: running");
    expect(processRegistered).toBe(false);
    const execId = detached.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1];
    if (!execId) throw new Error(`missing exec id in: ${detached}`);
    expect(processes.snapshots().find((item) => item.exec_id === execId)?.status).toBe("running");
    await processes.terminateSession("s1");
    expect(processes.snapshots().find((item) => item.exec_id === execId)?.status).toBe("killed");
    await processes.stop();
  }, 30_000);

  test("keeps at most 64 recent exec records per session", async () => {
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {});
    const executions = await Promise.all(Array.from({ length: 65 }, async (_unused, index) => {
      const result = String((await registry.execute("exec", {
        command: evalCommand(`console.log(${index})`),
      }, { ...context(), tool_call_id: `tool-exec-${index}` })).content[0]?.text);
      return result.match(/^exec_id: (exec_[a-z0-9]+)/mu)?.[1] ?? "";
    }));
    expect(executions.every(Boolean)).toBe(true);
    const snapshots = processes.snapshots().filter((item) => item.session_id === "s1");
    expect(snapshots).toHaveLength(64);
    expect(snapshots.some((item) => item.exec_id === executions[0])).toBe(false);
    await processes.stop();
  }, 30_000);

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
          attributionSkill: "replenishment-store-resolve",
        },
        {
          command: "lxeskill fba shipment delivery-csv-download",
          module: "services.agent_cli.mabang.download_fba_delivery_csv",
          ownerSkills: ["fba-shipment-delivery-csv-download"],
          attributionSkill: "fba-shipment-delivery-csv-download",
        },
      ],
    });
    await registry.execute("write", { file_path: "src/a.py", content: "alpha\nbeta\nbeta\n" }, context(root));
    const count = await registry.execute("grep", {
      pattern: "beta", path: "src", output_mode: "count", type: "py",
    }, context(root));
    expect(String(count.content[0]?.text).replaceAll("\\", "/")).toContain("src/a.py:2");
    await expect(registry.execute("send_files", { paths: ["src/a.py"] }, context(root))).rejects.toThrow("artifacts");
    await registry.execute("write", { file_path: "artifacts/a.txt", content: "ok" }, context(root));
    expect((await registry.execute("send_files", { paths: ["artifacts/a.txt"] }, context(root))).files).toHaveLength(1);
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
      attributionSkill: "replenishment-store-resolve",
    });
    await expect(registry.execute("exec", {
      command: "lxeskill replenish store resolve",
      "yield-time-ms": 120_000,
    }, context(root))).rejects.toThrow("between 250 and 30000 milliseconds");
    expect(registry.definition("exec")?.input_schema.properties).toMatchObject({
      command: { description: expect.stringContaining("exactly one standalone") },
      "yield-time-ms": { type: "number", minimum: 250, maximum: 30_000, default: 10_000 },
    });
    expect(registry.definition("wait")?.input_schema.properties).toMatchObject({
      exec_id: { type: "string" },
      "yield-time-ms": { type: "number", minimum: 5_000, maximum: 300_000, default: 10_000 },
      terminate: { type: "boolean", default: false },
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
