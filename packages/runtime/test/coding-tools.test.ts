import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCodingTools } from "../src/coding-tools";
import { ToolRegistry } from "../src/tools";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = () => ({
  session_id: "s1",
  handle: {
    signal: new AbortController().signal,
    cancelled: false,
    drainSteering: () => [],
    registerProcess: () => () => undefined,
  },
});

describe("native coding tools", () => {
  test("exposes compatible coding schemas and keeps file operations inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, { workspaceRoot: root });
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

  test("background exec sessions can be listed, polled, logged, and removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-process-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, { workspaceRoot: root });
    const started = await registry.execute("exec", {
      command: "Start-Sleep -Milliseconds 80; Write-Output done",
      background: true,
    }, context());
    const payload = JSON.parse(String(started.content[0]?.text));
    expect(payload.status).toBe("running");
    expect(payload.session).toMatch(/^exec_/);
    expect(JSON.parse(String((await registry.execute("process", { action: "list" }, context())).content[0]?.text)).items).toHaveLength(1);
    await Bun.sleep(180);
    const polled = JSON.parse(String((await registry.execute("process", { action: "poll", session: payload.session }, context())).content[0]?.text));
    expect(polled.status).toBe("completed");
    expect(polled.output).toContain("done");
    await registry.execute("process", { action: "remove", session: payload.session }, context());
    expect(processes.snapshots()).toHaveLength(0);
    await processes.stop();
  });
});
