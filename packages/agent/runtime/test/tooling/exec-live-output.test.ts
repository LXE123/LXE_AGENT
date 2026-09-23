import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { registerCodingTools } from "../../src/tooling/coding-tools";
import { ToolRegistry } from "../../src/tooling/registry";
import { workspaceFor } from "../workspace";
import { removeTemporaryRoot } from "../temp-directory";
import { ExecShellAdapter } from "../../src/tooling/exec-shell";
import { buildExecOutputStep } from "../../src/tooling/tool-display";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("output update did not arrive before the deadline");
    await Bun.sleep(10);
  }
}

test("exec publishes output before returning, coalesces updates and preserves the wait cursor", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-live-output-"));
  writeFileSync(join(root, "child.js"), `
    const fs = require('node:fs');
    console.log('first');
    while (!fs.existsSync('continue')) await Bun.sleep(10);
    for (let i = 0; i < 100; i++) { process.stdout.write('chunk-' + i + '\\n'); await Bun.sleep(2); }
    console.error('second');
    while (!fs.existsSync('finish')) await Bun.sleep(10);
    console.log('last'); process.exit(4);
  `);
  const registry = new ToolRegistry();
  const updates: JsonObject[] = [], completions: JsonObject[] = [];
  let releaseConsumer!: () => void;
  const consumer = new Promise<void>(resolve => { releaseConsumer = resolve; });
  let blocked = false;
  const manager = registerCodingTools(registry, {
    onExecUpdate: async snapshot => { updates.push(snapshot); if (blocked) await consumer; },
    onExecComplete: snapshot => { completions.push(snapshot); },
  });
  const context = {
    session_id: "s", turn_id: "turn", response_route_id: "route", tool_call_id: "call", workspace: workspaceFor(root),
    handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => undefined },
  };
  let returned = false;
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" child.js`;
  const execution = registry.execute("exec", { command, "yield-time-ms": 1_000 }, context).then(result => { returned = true; return result; });
  try {
    await until(() => updates.some(update => String(update.output_tail).includes("first")));
    expect(returned).toBe(false);
    expect(updates[0]!.status).toBe("running");
    await execution;
    const id = String(updates[0]!.exec_id);
    blocked = true;
    writeFileSync(join(root, "continue"), "");
    await until(() => String(manager.snapshots()[0]?.output_tail).includes("second"));
    const whileBlocked = updates.length;
    await Bun.sleep(150);
    expect(updates).toHaveLength(whileBlocked);
    const polled = await manager.wait({ execId: id, sessionId: "s", yieldMs: 0, terminate: false, signal: context.handle.signal });
    expect(polled.new_output).toContain("chunk-0");
    expect(polled.new_output).toContain("second");
    expect(polled.new_output).not.toContain("first");
    writeFileSync(join(root, "finish"), "");
    await until(() => manager.snapshots()[0]?.status === "failed");
    releaseConsumer();
    await until(() => updates.at(-1)?.status === "failed");
    expect(updates.at(-1)?.output_tail).toContain("last");
    expect(updates.at(-1)?.exit_code).toBe(4);
    expect(updates.length).toBeLessThan(10);
    expect(updates.every((update, index) => index === 0 || Number(update.revision) > Number(updates[index - 1]!.revision))).toBe(true);
    expect(completions).toHaveLength(1);
  } finally {
    releaseConsumer();
    await manager.stop();
    await execution;
    await removeTemporaryRoot(root);
  }
}, 20_000);

test.each(["utf8", "gbk"])("live %s byte chunks, stream ordering and bounded previews survive a real subprocess", async encoding => {
  const root = mkdtempSync(join(tmpdir(), "lxe-live-bytes-"));
  // Direct child preserves original bytes on Windows too; the first test exercises the default shell.
  const shell = new ExecShellAdapter();
  shell.spawnSpec = () => ({ argv: [process.execPath, join(root, "child.js")], detached: process.platform !== "win32" });
  const bytes = encoding === "utf8" ? [0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87] : [0xd6, 0xd0, 0xce, 0xc4];
  writeFileSync(join(root, "child.js"), `
    const fs = require('node:fs');
    for (const byte of ${JSON.stringify(bytes)}) { process.stdout.write(Buffer.from([byte])); await Bun.sleep(20); }
    while (!fs.existsSync('continue')) await Bun.sleep(10);
    process.stderr.write('warning'); await Bun.sleep(40);
    process.stdout.write('x'.repeat(5000) + 'tail'); process.exit(0);
  `);
  const updates: JsonObject[] = [];
  const manager = registerCodingTools(new ToolRegistry(), { execShell: shell, onExecUpdate: snapshot => { updates.push(snapshot); } });
  const execution = manager.execute({ command: "child", cwd: root, sessionId: "s", turnId: "turn", toolCallId: "call",
    responseRouteId: "route", workspace: workspaceFor(root), yieldMs: 5_000, signal: new AbortController().signal });
  try {
    await until(() => updates.some(update => String(update.output_tail).includes("中文")));
    expect(updates.at(-1)?.status).toBe("running");
    writeFileSync(join(root, "continue"), "");
    const result = await execution;
    expect(result.status).toBe("completed");
    const output = String(result.output);
    expect(output).toContain("[stdout]\n中文");
    expect(output.indexOf("中文")).toBeLessThan(output.indexOf("[stderr]\nwarning"));
    expect(output.indexOf("warning")).toBeLessThan(output.lastIndexOf("[stdout]"));
    expect(updates.at(-1)?.output_tail).toHaveLength(2000);
    expect(updates.at(-1)?.preview_truncated).toBe(true);
    const step = buildExecOutputStep(updates.at(-1)!);
    expect(step.result_block?.content).toContain("preview truncated");
    expect(step.result_block?.content).toEndWith("tail");
    expect(manager.snapshots()[0]?.revision).toBe(updates.at(-1)?.revision);
  } finally { await manager.stop(); await execution; await removeTemporaryRoot(root); }
}, 15_000);

test("empty foreground completion and termination both publish final updates without changing completion callback semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-live-end-"));
  const shell = new ExecShellAdapter();
  shell.spawnSpec = source => ({ argv: [process.execPath, "-e", source], detached: process.platform !== "win32" });
  const updates: JsonObject[] = [], completed: JsonObject[] = [];
  const manager = registerCodingTools(new ToolRegistry(), { execShell: shell,
    onExecUpdate: snapshot => { updates.push(snapshot); }, onExecComplete: snapshot => { completed.push(snapshot); } });
  const request = { command: "void 0;", cwd: root, sessionId: "s", turnId: "turn", toolCallId: "call",
    responseRouteId: "route", workspace: workspaceFor(root), yieldMs: 5_000, signal: new AbortController().signal };
  try {
    expect((await manager.execute(request)).status).toBe("completed");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.output_tail).toBe("");
    expect(completed).toHaveLength(0);
    const started = await manager.execute({ ...request, command: "console.log('before-kill'); setInterval(() => {}, 1000)", yieldMs: 100 });
    expect(started.status).toBe("running");
    await manager.wait({ execId: String(started.exec_id), sessionId: "s", yieldMs: 0, terminate: true, signal: request.signal });
    expect(updates.at(-1)?.status).toBe("killed");
    expect(updates.at(-1)?.output_tail).toContain("before-kill");
    expect(completed).toHaveLength(1);
    const count = updates.length;
    await Bun.sleep(150);
    expect(updates).toHaveLength(count);
  } finally { await manager.stop(); await removeTemporaryRoot(root); }
}, 15_000);
