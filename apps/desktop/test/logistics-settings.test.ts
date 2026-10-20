import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopLogisticsSettingsService } from "../src/main/logistics-settings";
import type { DesktopInputAssetsOptions } from "../src/main/input-assets";
import { validateLogisticsProfileInput, validateLogisticsRevision, validateLogisticsProfileId } from "../src/main/ipc-validation";
import { createDesktopBridge } from "../src/preload-bridge";
import { IPC_CHANNELS } from "../src/ipc-channels";
import { DesktopLogisticsCredentialStore } from "../src/main/logistics-credentials";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const state = { schema_version: 2, revision: 0, profiles: [], providers: [], stores: [], stores_error: null };
const input = { display_name: "天泰 A", provider_id: "tiantai", enabled: true, account_name: "公司 A", store_binding: { store_id: "base64==", store_name: "店铺 A" } };
const key = randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value: string) {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  },
  decryptString(value: Buffer) {
    const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
  },
};
function service(execute: DesktopInputAssetsOptions["execute"]) {
  const root = mkdtempSync(join(tmpdir(), "logistics-settings-")); roots.push(root);
  return new DesktopLogisticsSettingsService({ dataRoot: root, pythonPath: "python", managedPath: "", platform: process.platform,
    environment: () => ({ ZINIAO_PASSWORD: "environment-only-credential", ZINIAO_COMPANY: "fixture-company" }), execute, safeStorage });
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
  await store.delete("00000000-0000-0000-0000-000000000001", 0);
  expect(calls.map(call => call.slice(0, 5))).toEqual(["read", "refresh", "snapshot", "save", "snapshot", "delete"].map(action => ["-I", "-B", "-m", "services.agent_cli.logistics.settings", action]));
  expect(JSON.parse(calls[3]![5]!)).toEqual({ input: { ...input, login_username: null, credential_id: null }, expected_revision: 0 });
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
  for (const key of ["token", "credential_id", "password_configured", "url", "module", "sign", "created_at"]) expect(() => validateLogisticsProfileInput({ ...input, [key]: "secret" })).toThrow();
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
  const result = async () => { calls++; return { ...state, schema_version: 2 as const }; };
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

function integrated(storage = safeStorage) {
  const root = mkdtempSync(join(tmpdir(), "logistics-credentials-")); roots.push(root);
  let failSave: "before" | "after" | null = null;
  const requests: string[] = [];
  const make = () => new DesktopLogisticsSettingsService({ dataRoot: root,
    pythonPath: join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    managedPath: "", platform: process.platform, environment: () => ({}), safeStorage: storage,
    async execute(args, options) {
      requests.push(JSON.stringify({ args, env: options.env }));
      if (args[4] === "save" && failSave === "before") return { stdout: "", stderr: "fixture save denied", error: new Error("exit 1") };
      const child = Bun.spawn([join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
        "-I", "-B", "-c", "from services.agent_cli.logistics import settings; settings.discover_stores=lambda: []; raise SystemExit(settings.main())", ...args.slice(4)],
      { cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (args[4] === "save" && failSave === "after") return { stdout: "", stderr: "fixture response lost after save", error: new Error("timeout") };
      return { stdout, stderr, error: exit === 0 ? null : new Error(`exit ${exit}`) };
    } });
  return { root, make, store: make(), requests, fail(value: typeof failSave) { failSave = value; },
    files: () => { try { return readdirSync(join(root, "config", "logistics-credentials")); } catch { return []; } },
    snapshot: () => JSON.parse(readFileSync(join(root, "skill-data", "logistics-query", "profiles.json"), "utf8")),
    credentials: new DesktopLogisticsCredentialStore(root, storage),
  };
}
const loginInput = { ...input, login_username: "login-123@example.test" };

test("credentials survive service recreation without entering Python, public JSON or returned state", async () => {
  const h = integrated();
  const result = await h.store.save({ ...loginInput, password: "  private password  " }, 0);
  const profile = result.profiles[0]!;
  expect(profile.login_username).toBe("login-123@example.test");
  expect(profile.account_name).toBe("公司 A");
  expect(profile.password_configured).toBe(true);
  expect(profile).not.toHaveProperty("password"); expect(profile).not.toHaveProperty("credential_id");
  const reference = h.snapshot().profiles[0].credential_id;
  expect(h.credentials.read(reference).password).toBe("  private password  ");
  expect(JSON.stringify(h.snapshot())).not.toContain("private password");
  expect(h.requests.join("\n")).not.toContain("private password");
  const file = readFileSync(join(h.root, "config", "logistics-credentials", h.files()[0]!));
  expect(file.toString()).not.toContain("private password");
  expect((await h.make().read()).profiles[0]).toEqual(profile);
});

test("keep, replace, clear and delete affect only the selected profile credentials", async () => {
  const h = integrated();
  const first = (await h.store.save({ ...loginInput, password: "first-password" }, 0)).profiles[0]!;
  await h.store.save({ ...loginInput, display_name: "天泰 B", login_username: "other-user", password: "other-password" }, 1);
  await expect(h.store.save({ ...loginInput, password: "stale-password" }, 1)).rejects.toThrow("Revision conflict");
  expect(h.files()).toHaveLength(2);
  const originalReference = h.snapshot().profiles[0].credential_id;
  const { password_configured: _configured, created_at: _created, updated_at: _updated, ...edit } = first;
  await h.store.save({ ...edit, enabled: false }, 2);
  expect(h.snapshot().profiles.find((p: {profile_id: string}) => p.profile_id === first.profile_id).credential_id).toBe(originalReference);
  expect(h.files()).toHaveLength(2);
  await expect(h.store.save({ ...edit, login_username: "changed-without-password" }, 3)).rejects.toThrow("Enter a new password");
  await expect(h.store.save({ ...edit, provider_id: "wesa" }, 3)).rejects.toThrow("Enter a new password");
  expect(h.snapshot().revision).toBe(3);
  await h.store.save({ ...edit, password: "replacement-password" }, 3);
  expect(h.credentials.has(originalReference)).toBe(false);
  expect(h.files()).toHaveLength(2);
  const other = h.snapshot().profiles.find((p: {profile_id: string}) => p.profile_id !== first.profile_id);
  expect(h.credentials.read(other.credential_id).password).toBe("other-password");
  await h.store.save({ ...edit, password: null }, 4);
  expect((await h.store.read()).profiles.find(p => p.profile_id === first.profile_id)?.password_configured).toBe(false);
  expect(h.files()).toHaveLength(1);
  await h.store.delete(other.profile_id, 5);
  expect(h.files()).toHaveLength(0);
});

test("a failed or uncertain save never removes the password needed by a committed profile", async () => {
  const h = integrated();
  const first = (await h.store.save({ ...loginInput, password: "old-password" }, 0)).profiles[0]!;
  const oldReference = h.snapshot().profiles[0].credential_id;
  h.fail("before");
  await expect(h.store.save({ ...loginInput, profile_id: first.profile_id, password: "new-password" }, 1)).rejects.toThrow("fixture save denied");
  expect(h.snapshot().revision).toBe(1);
  expect(h.credentials.read(oldReference).password).toBe("old-password");
  h.fail("after");
  await expect(h.store.save({ ...loginInput, profile_id: first.profile_id, password: "committed-password" }, 1)).rejects.toThrow("fixture response lost");
  h.fail(null);
  expect(h.snapshot().revision).toBe(2);
  expect(h.credentials.read(h.snapshot().profiles[0].credential_id).password).toBe("committed-password");
  expect((await h.make().read()).profiles[0]!.password_configured).toBe(true);
});

test("unavailable encryption and invalid credentials cannot create a saved login", async () => {
  const h = integrated({ ...safeStorage, isEncryptionAvailable: () => false });
  await expect(h.store.save({ ...loginInput, password: "private-password" }, 0)).rejects.toThrow("Secure credential storage is unavailable");
  expect(h.snapshot().profiles).toHaveLength(0); expect(h.files()).toHaveLength(0);
  await expect(h.store.save({ ...input, password: "private-password" }, 0)).rejects.toThrow("login username is required");
  for (const change of [{ password: "" }, { password: "x".repeat(1025) }, { password: 123 }, { password: "line\nbreak" },
    { login_username: " padded" }, { login_username: "" }, { login_username: "x".repeat(201) },
    { provider_id: "jiufang", account_name: null, store_binding: null, login_username: "user" }]) {
    expect(() => validateLogisticsProfileInput({ ...loginInput, ...change })).toThrow();
  }
});

test("actual credential encryption diagnostics are retained with the password redacted", async () => {
  const password = "test-private-value";
  const h = integrated({ ...safeStorage, encryptString() { throw new Error(`fixture keychain failure: ${password}`); } });
  let message = "";
  try { await h.store.save({ ...loginInput, password }, 0); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("fixture keychain failure"); expect(message).toContain("[redacted]"); expect(message).not.toContain(password);
});

test("profiles without passwords remain editable when secure storage is unavailable", async () => {
  const h = integrated({ ...safeStorage, isEncryptionAvailable: () => false });
  const first = (await h.store.save(input, 0)).profiles[0]!;
  expect(first.password_configured).toBe(false); expect(first.login_username).toBeNull();
  const after = await h.store.save({ ...input, profile_id: first.profile_id, login_username: "new-user" }, 1);
  expect(after.profiles[0]!.account_name).toBe("公司 A");
  expect(after.profiles[0]!.login_username).toBe("new-user");
  expect(after.profiles[0]!.password_configured).toBe(false); expect(h.files()).toHaveLength(0);
});
