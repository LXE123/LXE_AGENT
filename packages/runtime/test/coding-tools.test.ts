import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { registerCodingTools } from "../src/coding-tools";
import { ToolRegistry } from "../src/tools";
import { registerToolSearch } from "../src/tool-search";

const roots: string[] = [];
const powershellTest = Bun.which("pwsh") || Bun.which("powershell") ? test : test.skip;
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

  powershellTest("background exec sessions can be listed, polled, logged, and removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-process-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const completed: JsonObject[] = [];
    const processes = registerCodingTools(registry, { workspaceRoot: root, onProcessComplete: async (snapshot) => { completed.push(snapshot); } });
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
    expect(completed).toEqual([expect.objectContaining({ session: payload.session, status: "completed" })]);
    await registry.execute("process", { action: "remove", session: payload.session }, context());
    expect(processes.snapshots()).toHaveLength(0);
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
      file_path: "user_session_db/sessions.json", content: "{}",
    }, context())).rejects.toThrow("protected");
    await processes.stop();
  });

  test("restores grep modes, find ordering, send boundaries, and business CLI guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-coding-contract-"));
    roots.push(root);
    const registry = new ToolRegistry();
    const processes = registerCodingTools(registry, { workspaceRoot: root });
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
    }, context())).rejects.toThrow("JSON script bridge");
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
