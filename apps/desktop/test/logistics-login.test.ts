import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopLogisticsCredentialStore } from "../src/main/logistics-credentials";
import { DesktopLogisticsSettingsService } from "../src/main/logistics-settings";
import { LogisticsLoginHost, type LogisticsLoginRequest } from "../src/main/logistics-login-host";

const roots: string[] = [];
const hosts: LogisticsLoginHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// Test port only: transport assertions do not claim native safeStorage QA.
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
const request: LogisticsLoginRequest = { profile_id: "00000000-0000-0000-0000-000000000001", store_id: "store==", session_id: "lxe-test", expected_revision: 3 };

function service(password: string, execution = { stdout: '{"success":true,"status":"authenticated"}', stderr: "", error: null as Error | null }) {
  const root = mkdtempSync(join(tmpdir(), "logistics-login-")); roots.push(root);
  const credentials = new DesktopLogisticsCredentialStore(root, safeStorage);
  const reference = credentials.write({ provider_id: "wesa", login_username: "fixture-user", password });
  const profile = { profile_id: request.profile_id, provider_id: "wesa", login_username: "fixture-user", enabled: true, credential_id: reference };
  const calls: { args: string[]; environment: NodeJS.ProcessEnv; stdin: string }[] = [];
  const instance = new DesktopLogisticsSettingsService({ dataRoot: root, pythonPath: "python", managedPath: "", platform: process.platform,
    safeStorage, environment: () => ({}),
    execute: async () => ({ stdout: JSON.stringify({ success: true, data: { schema_version: 3, revision: 3, profiles: [profile], providers: [] } }), stderr: "", error: null }),
    executeLogin: async (args, environment, stdin) => { calls.push({ args, environment, stdin }); return execution; },
  });
  return { instance, profile, calls };
}

test("password goes only through private worker stdin, never argv/environment/RPC result", async () => {
  const password = 'private-"login"-value';
  const h = service(password, { stdout: JSON.stringify({ success: true, status: "authenticated", configured_login_submitted: true, profile_identity_verified: false }), stderr: "", error: null });
  expect(await h.instance.ensureLogin(request)).toEqual({ success: true, status: "authenticated", configured_login_submitted: true, profile_identity_verified: false });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.args).toEqual(["-I", "-B", "-m", "services.agent_cli.logistics.login_worker"]);
  expect(JSON.stringify(h.calls[0]!.args)).not.toContain(password);
  expect(JSON.stringify(h.calls[0]!.environment)).not.toContain(password);
  expect(h.calls[0]!.environment.LXE_AGENT_SESSION_ID).toBe("lxe-test");
  expect(JSON.parse(h.calls[0]!.stdin)).toEqual({ provider_id: "wesa", store_id: "store==", login_username: "fixture-user", password });
});

test("revision, enabled state and encrypted identity are checked before execution", async () => {
  const h = service("secret");
  expect(await h.instance.ensureLogin({ ...request, expected_revision: 2 })).toMatchObject({ success: false, error: { message: expect.stringContaining("Revision conflict") } });
  h.profile.enabled = false;
  expect(await h.instance.ensureLogin(request)).toMatchObject({ success: false, error: { message: expect.stringContaining("disabled") } });
  h.profile.enabled = true; h.profile.login_username = "different-user";
  expect(await h.instance.ensureLogin(request)).toMatchObject({ success: false, error: { message: expect.stringContaining("identity does not match") } });
  expect(h.calls).toHaveLength(0);
});

test.each(['private-"quoted"-secret', "success", "a"])("parsed diagnostics redact secret values without corrupting JSON structure: %s", async password => {
  const h = service(password, { stdout: JSON.stringify({ success: false, error: { code: "selenium_failed", message: `actual fixture: ${password}` }, password }), stderr: "", error: new Error("exit 1") });
  const result = await h.instance.ensureLogin(request) as { success: boolean; error: { code: string; message: string }; password: string };
  expect(result.success).toBe(false);
  expect(result.error.code).toBe("selenium_failed".replaceAll(password, "[redacted]"));
  expect(result.password).toBe("[redacted]");
  expect(result.error.message).toContain("[redacted]");
});

test("startup and malformed worker errors retain actual diagnostics with raw and JSON-escaped secrets redacted", async () => {
  const password = 'private-"quoted"-secret';
  const h = service(password, { stdout: `invalid-json ${JSON.stringify(password)}`, stderr: `actual fixture startup failure ${password}`, error: new Error("fixture exit 1") });
  const result = JSON.stringify(await h.instance.ensureLogin(request));
  expect(result).toContain("actual fixture startup failure"); expect(result).toContain("fixture exit 1");
  expect(result).not.toContain("private-"); expect(result).toContain("[redacted]");
});

test("stopped login service cannot start a worker", async () => {
  const h = service("secret"); await h.instance.stopLogins();
  expect(await h.instance.ensureLogin(request)).toMatchObject({ success: false, error: { message: expect.stringContaining("stopping") } });
  expect(h.calls).toHaveLength(0);
});

test("a canceled login cannot start a worker", async () => {
  const h = service("secret");
  const controller = new AbortController(); controller.abort(new Error("fixture canceled"));
  expect(await h.instance.ensureLogin(request, controller.signal)).toMatchObject({ success: false,
    error: { message: expect.stringContaining("fixture canceled") } });
  expect(h.calls).toHaveLength(0);
});

test("disconnecting the internal caller cancels the login operation", async () => {
  let entered!: () => void, aborted!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stopped = new Promise<void>(resolve => { aborted = resolve; });
  const instance = new LogisticsLoginHost(async (_, signal) => {
    entered();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted(); resolve(); }, { once: true }));
    return { success: false };
  });
  hosts.push(instance); await instance.start();
  const env = instance.environment();
  const controller = new AbortController();
  const pending = fetch(env.LXE_LOGISTICS_LOGIN_HOST_URL + "/v1/logistics/login", { method: "POST", signal: controller.signal,
    headers: { Authorization: `Bearer ${env.LXE_LOGISTICS_LOGIN_HOST_TOKEN}` }, body: JSON.stringify(request) }).catch(error => error);
  await started; controller.abort();
  await Promise.all([pending, stopped]);
});

async function host() {
  const calls: LogisticsLoginRequest[] = [];
  const instance = new LogisticsLoginHost(async input => { calls.push(input); return { success: true, status: "fixture" }; });
  hosts.push(instance); await instance.start();
  const env = instance.environment();
  return { instance, calls, url: env.LXE_LOGISTICS_LOGIN_HOST_URL + "/v1/logistics/login",
    headers: { Authorization: `Bearer ${env.LXE_LOGISTICS_LOGIN_HOST_TOKEN}`, "Content-Type": "application/json" } };
}

test("login host requires private bearer, denies browser origins and accepts only the fixed endpoint", async () => {
  const h = await host();
  for (const headers of [{}, { ...h.headers, Origin: "http://127.0.0.1" }]) {
    expect((await fetch(h.url, { method: "POST", headers, body: JSON.stringify(request) })).status).toBe(403);
  }
  expect((await fetch(h.url + "/other", { method: "POST", headers: h.headers, body: JSON.stringify(request) })).status).toBe(404);
  expect((await fetch(h.url, { headers: h.headers })).status).toBe(404);
  expect(h.calls).toHaveLength(0);
  const response = await fetch(h.url, { method: "POST", headers: h.headers, body: JSON.stringify(request) });
  expect(await response.json()).toEqual({ success: true, status: "fixture" });
  expect(h.calls).toEqual([request]);
});

test.each([{ ...request, password: "forbidden" }, { ...request, store_id: "" }, { ...request, session_id: " padded" },
  { ...request, profile_id: "../credential" }, { ...request, expected_revision: true }, { ...request, extra: "x".repeat(4096) }])("malformed login requests are rejected before credential access %#", async body => {
  const h = await host();
  const response = await fetch(h.url, { method: "POST", headers: h.headers, body: JSON.stringify(body) });
  expect(response.status).toBe(400); expect(h.calls).toHaveLength(0);
});
