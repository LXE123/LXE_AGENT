import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
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
      command: "Write-Output ('x' * 3000)",
    }, context())).content[0]?.text);
    expect(completedText).toContain("status: completed");
    expect(completedText).toContain("output:");
    expect(completedText.length).toBeGreaterThan(2_000);

    const failed = String((await registry.execute("exec", {
      command: "Write-Error 'expected failure'",
    }, context())).content[0]?.text);
    expect(failed).toContain("status: failed");
    expect(failed).toContain("expected failure");
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
