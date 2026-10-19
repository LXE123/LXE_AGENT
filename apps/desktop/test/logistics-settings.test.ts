import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopLogisticsSettingsService } from "../src/main/logistics-settings";
import type { DesktopInputAssetsOptions } from "../src/main/input-assets";
import { validateLogisticsProfileInput, validateLogisticsRevision, validateLogisticsProfileId } from "../src/main/ipc-validation";
import { createDesktopBridge } from "../src/preload-bridge";
import { IPC_CHANNELS } from "../src/ipc-channels";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const state = { schema_version: 1, revision: 0, profiles: [], providers: [], stores: [], stores_error: null };
const input = { display_name: "天泰 A", provider_id: "tiantai", enabled: true, account_name: "公司 A", store_binding: { store_id: "base64==", store_name: "店铺 A" } };
function service(execute: DesktopInputAssetsOptions["execute"]) {
  const root = mkdtempSync(join(tmpdir(), "logistics-settings-")); roots.push(root);
  return new DesktopLogisticsSettingsService({ dataRoot: root, pythonPath: "python", managedPath: "", platform: process.platform,
    environment: () => ({ ZINIAO_PASSWORD: "environment-only-credential", ZINIAO_COMPANY: "fixture-company" }), execute });
}
test("fixed private module, revision and environment-only credentials", async () => {
  const calls: string[][] = [];
  const store = service(async (args, options) => {
    calls.push(args);
    expect(args.join(" ")).not.toContain("environment-only-credential");
    expect(options.env?.ZINIAO_PASSWORD).toBe("environment-only-credential");
    expect(options.env?.LXE_DATA_ROOT).toContain("logistics-settings-");
    expect(options.env?.TMP).toBe(options.env?.TMPDIR);
    expect(options.timeout).toBeGreaterThan(0);
    return { stdout: JSON.stringify({ success: true, data: state }), stderr: "", error: null };
  });
  await store.read(); await store.refresh(); await store.save(input, 0);
  await store.delete("00000000-0000-0000-0000-000000000001", 1);
  expect(calls.map(call => call.slice(0, 5))).toEqual(["read", "refresh", "save", "delete"].map(action => ["-I", "-B", "-m", "services.agent_cli.logistics.settings", action]));
  expect(JSON.parse(calls[2]![5]!)).toEqual({ input, expected_revision: 0 });
});
test.each([
  { stdout: "broken-json", stderr: "", error: null },
  { stdout: "", stderr: "PermissionError: fixture storage denied", error: new Error("exit 1") },
  { stdout: "", stderr: "", error: new Error("fixture timeout: process killed") },
  { stdout: JSON.stringify({ success: false, error: "fixture schema failure" }), stderr: "", error: new Error("exit 1") },
])("preserves observed bounded diagnostics %#", async execution => {
  let message = "";
  try { await service(async () => execution).read(); } catch (error) { message = (error as Error).message; }
  expect(message).toContain(execution.stdout === "broken-json" ? "broken-json" : execution.stderr || (execution.stdout ? "fixture schema failure" : "fixture timeout"));
});
test("redacts supplied environment secrets before bounding both failure and store diagnostics", async () => {
  await expect(service(async () => ({ stdout: "", stderr: "environment-only-credential " + "x".repeat(6000), error: new Error("exit 1") })).read()).rejects.toThrow("[truncated]");
  const store = service(async () => ({ stdout: JSON.stringify({ success: true, data: { ...state, stores_error: "fixture: environment-only-credential" } }), stderr: "", error: null }));
  expect((await store.read()).stores_error).toBe("fixture: [redacted]");
});
test("main validation rejects unknown fields, malformed identities and forbidden combinations", () => {
  expect(validateLogisticsProfileInput(input)).toEqual(input);
  for (const provider_id of ["feiwo", "yuntuo"]) expect(validateLogisticsProfileInput({ ...input, provider_id, account_name: null }).account_name).toBeNull();
  expect(validateLogisticsProfileInput({ ...input, provider_id: "jiufang", account_name: null, store_binding: null }).store_binding).toBeNull();
  for (const key of ["token", "password", "url", "module", "sign", "created_at"]) expect(() => validateLogisticsProfileInput({ ...input, [key]: "secret" })).toThrow();
  for (const change of [{ display_name: "x".repeat(81) }, { display_name: "" }, { enabled: 1 }, { provider_id: "other" }, { provider_id: "jiufang" }, { store_binding: null }, { account_name: "x" }, { store_binding: { ...input.store_binding, browser_id: 1 } }]) {
    expect(() => validateLogisticsProfileInput({ ...input, ...change })).toThrow();
  }
  for (const value of [true, -1, "0", 1.5, Number.MAX_SAFE_INTEGER]) expect(() => validateLogisticsRevision(value)).toThrow();
  for (const id of ["bad", "00000000-0000-0000-0000-00000000000X"]) expect(() => validateLogisticsProfileId(id)).toThrow();
});
test("preload exposes the four explicit logistics IPC calls", async () => {
  const calls: unknown[] = [];
  const bridge = createDesktopBridge({ invoke: async <T>(...args: unknown[]) => { calls.push(args); return state as T; }, on() {}, removeListener() {} }, "darwin").desktop;
  await bridge.getLogisticsSettings(); await bridge.refreshLogisticsStores();
  await bridge.saveLogisticsProfile({ ...input, provider_id: "tiantai" }, 3); await bridge.deleteLogisticsProfile("id", 4);
  expect(calls).toEqual([[IPC_CHANNELS.getLogisticsSettings], [IPC_CHANNELS.refreshLogisticsStores], [IPC_CHANNELS.saveLogisticsProfile, input, 3], [IPC_CHANNELS.deleteLogisticsProfile, "id", 4]]);
});


test("every logistics handler requires the trusted main frame and validates before dispatch", async () => {
  const { registerLogisticsIpc } = await import("../src/main/logistics-ipc");
  const handlers = new Map<string, (event: import("electron").IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const trusted = {} as import("electron").IpcMainInvokeEvent;
  let calls = 0;
  const result = async () => { calls++; return { ...state, schema_version: 1 as const }; };
  registerLogisticsIpc({ handle(channel, handler) { handlers.set(channel, handler); } }, {
    isTrustedFileSender: event => event === trusted, getLogisticsSettings: result, refreshLogisticsStores: result,
    saveLogisticsProfile: result, deleteLogisticsProfile: result,
  });
  expect(handlers.size).toBe(4);
  for (const handler of handlers.values()) expect(() => handler({} as import("electron").IpcMainInvokeEvent, input, 0)).toThrow("main frame");
  expect(calls).toBe(0);
  expect(() => handlers.get(IPC_CHANNELS.saveLogisticsProfile)!(trusted, { ...input, token: "x" }, 0)).toThrow();
  expect(() => handlers.get(IPC_CHANNELS.deleteLogisticsProfile)!(trusted, "bad", 0)).toThrow();
  expect(calls).toBe(0);
  await handlers.get(IPC_CHANNELS.getLogisticsSettings)!(trusted);
  await handlers.get(IPC_CHANNELS.refreshLogisticsStores)!(trusted);
  await handlers.get(IPC_CHANNELS.saveLogisticsProfile)!(trusted, input, 0);
  await handlers.get(IPC_CHANNELS.deleteLogisticsProfile)!(trusted, "00000000-0000-0000-0000-000000000001", 1);
  expect(calls).toBe(4);
});
