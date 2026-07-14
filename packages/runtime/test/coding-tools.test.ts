import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { JsonObject } from "@lxe/protocol";
import { registerCodingTools } from "../src/coding-tools";
import { ToolRegistry } from "../src/tools";
import { registerToolSearch } from "../src/tool-search";

const roots: string[] = [];
const projectRoot = resolve(import.meta.dir, "../../..");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = () => ({
  session_id: "s1",
  turn_id: "turn-1",
  response_route_id: "route-1",
  handle: {
    signal: new AbortController().signal,
    cancelled: false,
    drainSteering: () => [],
    registerProcess: () => () => undefined,
  },
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
  test("exposes compatible coding schemas and keeps file operations inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      workspaceRoot: root,
      businessCommands: new Map([["lxeskill replenish store resolve", ["replenishment-store-resolve"]]]),
    });
    expect(registry.schemas().map((item) => item.name)).toEqual([
      "read", "write", "edit", "grep", "find", "ls", "send_file", "exec", "process",
    ]);
    await registry.execute("write", { file_path: "src/a.txt", content: "hello\nworld\n" }, context());
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toBe("hello\nworld\n");
    await registry.execute("edit", { file_path: "src/a.txt", old_string: "world", new_string: "Bun" }, context());
    const read = await registry.execute("read", { path: "src/a.txt", offset: 2, limit: 1 }, context());
    expect(read.content[0]?.text).toContain("Bun");
    const grep = await registry.execute("grep", { pattern: "Bun", path: "src" }, context());
    expect(grep.content[0]?.text).toContain("a.txt");
    const find = await registry.execute("find", { pattern: "*.txt", path: "src" }, context());
    expect(find.content[0]?.text).toContain("a.txt");
    const ls = await registry.execute("ls", { path: "src" }, context());
    expect(ls.content[0]?.text).toContain("a.txt");
    await expect(registry.execute("read", { path: "../outside.txt" }, context())).rejects.toThrow("workspace");
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
    await processes.stop();
  });

  test("exec sessions run cross-platform shell commands and lxeskill without PowerShell on Unix", async () => {
    mkdirSync(join(projectRoot, "tmp"), { recursive: true });
    const cwd = mkdtempSync(join(projectRoot, "tmp", "exec 中文 (space)-"));
    roots.push(cwd);
    const registry = new ToolRegistry();
    const completed: JsonObject[] = [];
    const processes = registerCodingTools(registry, { workspaceRoot: projectRoot, onProcessComplete: async (snapshot) => { completed.push(snapshot); } });
    const started = await registry.execute("exec", {
      command: "python -c \"import time; time.sleep(0.08); print('done')\"",
      cwd,
      background: true,
    }, context());
    const startedText = String(started.content[0]?.text);
    expect(startedText).toContain("status: running");
    const session = startedText.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
    expect(session).toMatch(/^exec_/);
    if (!session) throw new Error(`missing process session in: ${startedText}`);
    const listed = String((await registry.execute("process", { action: "list" }, context())).content[0]?.text);
    expect(listed).toContain(String(session));
    await Bun.sleep(180);
    const polled = String((await registry.execute("process", { action: "poll", session }, context())).content[0]?.text);
    expect(polled).toContain("status: completed");
    expect(polled).toContain("done");
    expect(completed).toEqual([expect.objectContaining({
      session,
      status: "completed",
      origin_turn_id: "turn-1",
    })]);
    await registry.execute("process", { action: "remove", session }, context());
    expect(processes.snapshots()).toHaveLength(0);

    const completedText = String((await registry.execute("exec", {
      command: "python -c \"print('x' * 3000)\"",
    }, context())).content[0]?.text);
    expect(completedText).toContain("status: completed");
    expect(completedText).toContain("output:");
    expect(completedText.length).toBeGreaterThan(2_000);

    const failed = String((await registry.execute("exec", {
      command: "python -c \"import sys; print('expected failure', file=sys.stderr); raise SystemExit(3)\"",
    }, context())).content[0]?.text);
    expect(failed).toContain("status: failed");
    expect(failed).toContain("expected failure");

    // Commands outside the attribution map still run: the CLI owns
    // authorization and list is always known to it.
    const lxeskillList = String((await registry.execute("exec", {
      command: "lxeskill list",
    }, context())).content[0]?.text);
    expect(lxeskillList).toContain("status: completed");
    await processes.stop();
  });

  test("exec forwards host env so lxeskill enforces the injected skill scope", async () => {
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      workspaceRoot: projectRoot,
      execEnv: () => ({ LXESKILL_SKILL_SCOPE: "replenishment-store-resolve" }),
    });
    const listed = String((await registry.execute("exec", {
      command: "lxeskill list",
    }, context())).content[0]?.text);
    expect(listed).toContain("replenish store resolve");
    expect(listed).not.toContain("fba customs fill");
    expect(listed).toContain("auth refresh");
    await processes.stop();
  });

  test("terminates the complete exec process tree", async () => {
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, { workspaceRoot: projectRoot });
    const startTree = async (): Promise<{ session: string; childPid: number }> => {
      const started = String((await registry.execute("exec", {
        command: "python -c \"import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(child.pid, flush=True); time.sleep(60)\"",
        background: true,
      }, context())).content[0]?.text);
      const session = started.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
      await Bun.sleep(100);
      const polled = session
        ? String((await registry.execute("process", { action: "poll", session }, context())).content[0]?.text)
        : "";
      const childPid = Number(`${started}\n${polled}`.match(/(?:tail|new_output):\s*(\d+)/u)?.[1]);
      expect(session).toMatch(/^exec_/);
      expect(childPid).toBeGreaterThan(0);
      if (!session || !childPid) throw new Error(`missing process identifiers in: ${started}`);
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
    await registry.execute("process", { action: "kill", session: killed.session }, context());
    await expectDead(killed.childPid);

    const forceKilled = await startTree();
    await processes.stop();
    await expectDead(forceKilled.childPid);
  });

  test("uses timeout seconds and ignores the timer for explicit background work", async () => {
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, { workspaceRoot: projectRoot });
    const timedOut = String((await registry.execute("exec", {
      command: "python -c \"import time; time.sleep(60)\"",
      timeout: 1,
      yield_ms: 2_000,
    }, context())).content[0]?.text);
    expect(timedOut).toContain("status: timeout");

    const background = String((await registry.execute("exec", {
      command: "python -c \"import time; time.sleep(0.05); print('background done')\"",
      timeout: 1,
      background: true,
    }, context())).content[0]?.text);
    const session = background.match(/^session: (exec_[a-z0-9]+)/mu)?.[1];
    expect(session).toMatch(/^exec_/);
    await Bun.sleep(100);
    const polled = session
      ? String((await registry.execute("process", { action: "poll", session }, context())).content[0]?.text)
      : "";
    expect(polled).toContain("status: completed");
    expect(polled).toContain("background done");

    const controller = new AbortController();
    const cancellation = registry.execute("exec", {
      command: "python -c \"import time; time.sleep(60)\"",
      timeout: 10,
      yield_ms: 2_000,
    }, {
      ...context(),
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
  });

  test("requires a current read before modifying existing files and protects runtime state", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-safety-"));
    roots.push(root);
    writeFileSync(join(root, "existing.txt"), "v1\n", "utf8");
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, { workspaceRoot: root });
    await expect(registry.execute("edit", {
      file_path: "existing.txt", old_string: "v1", new_string: "v2",
    }, context())).rejects.toThrow("先用 read");
    await registry.execute("read", { path: "existing.txt" }, context());
    writeFileSync(join(root, "existing.txt"), "external\n", "utf8");
    await expect(registry.execute("write", {
      file_path: "existing.txt", content: "blind overwrite\n",
    }, context())).rejects.toThrow("重新 read");
    await expect(registry.execute("write", { file_path: ".env", content: "SECRET=x" }, context()))
      .rejects.toThrow("protected");
    await expect(registry.execute("write", {
      file_path: "var/db/sessions.json", content: "{}",
    }, context())).rejects.toThrow("protected");
    await expect(registry.execute("write", {
      file_path: "var/logs/runtime/x.log", content: "{}",
    }, context())).rejects.toThrow("protected");
    await processes.stop();
  });

  test("reads images by content instead of extension and reports coordinate scaling", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-image-"));
    roots.push(root);
    writeFileSync(join(root, "screenshot.data"), onePixelPng());
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, { workspaceRoot: root });
    const result = await registry.execute("read", { path: "screenshot.data" }, context());
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
    const processes = registerCodingTools(registry, { workspaceRoot: root, ripgrepPath: null });
    await expect(registry.execute("read", { path: "payload.unknown" }, context())).rejects.toThrow("binary file");
    await processes.stop();
  });

  test("restores grep modes, find ordering, send boundaries, and business CLI guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-contract-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, {
      workspaceRoot: root,
      businessCommands: new Map([["lxeskill replenish store resolve", ["replenishment-store-resolve"]]]),
    });
    await registry.execute("write", { file_path: "src/a.py", content: "alpha\nbeta\nbeta\n" }, context());
    const count = await registry.execute("grep", {
      pattern: "beta", path: "src", output_mode: "count", type: "py",
    }, context());
    expect(String(count.content[0]?.text).replaceAll("\\", "/")).toContain("src/a.py:2");
    await expect(registry.execute("send_file", { path: "src/a.py" }, context())).rejects.toThrow("artifacts");
    await registry.execute("write", { file_path: "artifacts/a.txt", content: "ok" }, context());
    expect((await registry.execute("send_file", { path: "artifacts/a.txt" }, context())).files).toHaveLength(1);
    await expect(registry.execute("exec", {
      command: "python -m services.agent_cli.mabang.resolve_fba_store",
    }, context())).rejects.toMatchObject({ code: "permission_denied" });
    await expect(registry.execute("exec", {
      command: "python -m lxeskill replenish store resolve",
    }, context())).rejects.toMatchObject({ code: "permission_denied" });
    await expect(registry.execute("exec", {
      command: "echo lxeskill replenish store resolve",
    }, context())).rejects.toMatchObject({ code: "unsupported_invocation" });
    await expect(registry.execute("exec", {
      command: "lxeskill replenish store resolve && echo done",
    }, context())).rejects.toMatchObject({ code: "unsupported_invocation" });
    // Unknown commands pass through: authorization belongs to the CLI, which
    // rejects them with a structured error. Here the temp root has no .venv,
    // so normalization fails before any spawn.
    await expect(registry.execute("exec", {
      command: "lxeskill unknown command",
    }, context())).rejects.toThrow("project Python is unavailable");
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
    }, context())).rejects.toThrow("between 1 and 3600 seconds");
    expect(registry.definition("exec")?.input_schema.properties).toMatchObject({
      timeout: { type: "number", minimum: 1, maximum: 3_600, default: 120 },
      yield_ms: { type: "number", minimum: 1, default: 10_000 },
    });
    await processes.stop();
  });

  test("tool search discovers tools by name, description, and parameters", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "inventory_lookup", description: "Find stock by SKU", input_schema: { type: "object", properties: { sku: { type: "string" } } }, execute: async () => ({ content: [] }) });
    registerToolSearch(registry);
    const found = await registry.execute("tool_search", { query: "stock sku" }, context());
    expect(JSON.parse(String(found.content[0]?.text)).tools).toEqual([expect.objectContaining({ name: "inventory_lookup" })]);
  });
});
