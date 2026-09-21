import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { DesktopCloudContextClient, CloudContextError, parseContextResult } from "../src/main/cloud-context";
import { parseDeviceContext } from "../src/main/cloud-permissions";

export const fixtureContext = (skills = ["amazon_fba"], version = 1) => ({
  response_schema: "lxe.device-context.v1", device: { id: "device-a", kind: "managed_device", display_name: "设备 A", wireguard_ip: "10.88.0.8" },
  permission: { assignment_version: version, profile: { id: "custom", revision: 1, labels: { "zh-CN": "自定义", "en-US": "Custom" } },
    grants: { skill_types: skills, desktop_features: [], server_capabilities: [], erp_actions: [] } },
});
const result = (context = fixtureContext()) => JSON.stringify({ protocol_version: "1", type: "result", command: "cloud-context", ok: true, data: { device_context: context }, files: [] });

describe("device context bridge", () => {
  test("preserves HTTP denials from nonzero CLI exits", () => {
    const line = JSON.stringify({ protocol_version: "1", type: "result", command: "cloud-context", ok: false, error: { code: "business_device_denied", http_status: 403, message: "actual refusal" } });
    try { parseContextResult(line, 4, "generic process stderr"); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(CloudContextError); expect((error as CloudContextError).httpStatus).toBe(403); expect((error as Error).message).toBe("actual refusal"); }
  });
  test.each(["", "not-json", `${result()}\n${result()}`, result().replace('"1"','"2"')])("rejects malformed output %s", (output) => {
    expect(() => parseContextResult(output, 0, "")).toThrow("Invalid cloud-context output");
  });
  test("rejects inconsistent exit and success", () => expect(() => parseContextResult(result(), 4, "")).toThrow("Inconsistent"));
  test("binds grants to current device without inferring capabilities", () => {
    const parsed = parseDeviceContext(fixtureContext(), "device-a", "10.88.0.8", 100);
    expect(parsed.allowed_skill_types).toEqual(["amazon_fba"]);
    expect(parsed.desktop_features).toEqual([]);
    expect(() => parseDeviceContext(fixtureContext(), "device-b", "10.88.0.8", 100)).toThrow("identity mismatch");
  });
  test("actual managed Python only queries context, with no credentials or workspace side effects", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { calls.push({ url: request.url, headers: new Headers(request.headers) }); return Response.json(fixtureContext()); } });
    const root = mkdtempSync(join(tmpdir(), "lxe-context-bridge-"));
    try {
      const client = new DesktopCloudContextClient({ pythonPath: join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), cwd: root });
      expect(await client.query(`http://127.0.0.1:${server.port}`, new AbortController().signal)).toEqual(fixtureContext());
      expect(calls.length).toBe(1);
      expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/device-context");
      expect(calls[0]!.headers.get("x-lxe-client")).toBe("cli");
      expect(calls[0]!.headers.get("authorization")).toBeNull();
      expect(calls[0]!.headers.get("cookie")).toBeNull();
      expect(readdirSync(root)).toEqual([]);
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
  });
  test("actual subprocess timeout and cancellation close pending queries", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    const client = new DesktopCloudContextClient({ pythonPath: join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), cwd: process.cwd(), timeoutMs: 100 });
    try {
      await expect(client.query(`http://127.0.0.1:${server.port}`, new AbortController().signal)).rejects.toThrow("timed out");
      const controller = new AbortController();
      const query = client.query(`http://127.0.0.1:${server.port}`, controller.signal);
      controller.abort();
      await expect(query).rejects.toThrow("cancelled");
    } finally { server.stop(true); }
  });
});


test("bridge bounds stdout, strips credential environment and reaps the cancelled process", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {
    queueMicrotask(() => child.emit("close", null)); return true;
  } });
  let killed = 0;
  const kill = child.kill;
  child.kill = () => { killed++; return kill(); };
  const fakeSpawn = ((path: string, args: string[], options: any) => {
    expect(path).toBe(join(process.cwd(), "python.exe"));
    expect(args).toEqual(["-I", "-B", "-X", "utf8", "-m", "lxeskill", "cloud-context", "--server", "http://localhost"]);
    expect(Object.keys(options.env).some((key) => /LXE_|TOKEN|SECRET|PASSWORD|PROXY|PYTHONPATH/u.test(key))).toBe(false);
    queueMicrotask(() => child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1)));
    return child;
  }) as unknown as typeof spawn;
  const client = new DesktopCloudContextClient({ pythonPath: join(process.cwd(), "python.exe"), cwd: process.cwd(), spawn: fakeSpawn });
  await expect(client.query("http://localhost", new AbortController().signal)).rejects.toThrow("exceeded 2 MiB");
  expect(killed).toBe(1);
  expect(child.stdout.listenerCount("data")).toBe(0);
});

test("bridge bounds stderr and preserves an explicit truncation marker on invalid output", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const fakeSpawn = (() => {
    queueMicrotask(() => { child.stderr.write(Buffer.alloc(10_000, 120)); child.emit("close", 1); });
    return child;
  }) as unknown as typeof spawn;
  const client = new DesktopCloudContextClient({ pythonPath: join(process.cwd(), "python.exe"), cwd: process.cwd(), spawn: fakeSpawn });
  await expect(client.query("http://localhost", new AbortController().signal)).rejects.toThrow("[truncated]");
});
