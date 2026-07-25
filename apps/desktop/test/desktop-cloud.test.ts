import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
import { DesktopCloudEnrollmentManager, type CloudEnrollmentPayload } from "../src/main/cloud-enrollment";
import { DesktopConfigStore } from "../src/main/config-store";
import { DesktopCloudService, type DesktopCloudClock } from "../src/main/desktop-cloud";

const roots: string[] = [];
type LogEvent = { level: string; message: string; fields: Record<string, unknown> };
const testLogger = (events: LogEvent[], parent: Record<string, unknown> = {}): Logger => ({
  debug: (message, fields = {}) => events.push({ level: "debug", message, fields: { ...parent, ...fields } }),
  info: (message, fields = {}) => events.push({ level: "info", message, fields: { ...parent, ...fields } }),
  warn: (message, fields = {}) => events.push({ level: "warn", message, fields: { ...parent, ...fields } }),
  error: (message, fields = {}) => events.push({ level: "error", message, fields: { ...parent, ...fields } }),
  child: (fields) => testLogger(events, { ...parent, ...fields }),
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, "utf8"),
  decryptString: (value: Buffer) => value.toString("utf8"),
};

class FakeClock implements DesktopCloudClock {
  readonly intervals = new Set<() => void>();
  readonly timeouts = new Set<() => void>();

  setTimeout(callback: () => void): unknown {
    this.timeouts.add(callback);
    return callback;
  }

  clearTimeout(id: unknown): void {
    this.timeouts.delete(id as () => void);
  }

  setInterval(callback: () => void): unknown {
    this.intervals.add(callback);
    return callback;
  }

  clearInterval(id: unknown): void {
    this.intervals.delete(id as () => void);
  }

  fireIntervals(): void {
    for (const callback of [...this.intervals]) callback();
  }

  fireTimeouts(): void {
    const callbacks = [...this.timeouts];
    this.timeouts.clear();
    for (const callback of callbacks) callback();
  }
}

const enrollmentPayload: CloudEnrollmentPayload & { format: string; version: number } = {
  format: "lxe-agent-enrollment-payload",
  version: 1,
  device: { id: "0123456789abcdef0123456789abcdef", name: "Finance-PC-01" },
  wireguard: {
    private_key: Buffer.alloc(32, 1).toString("base64"),
    address: "10.88.0.8/32",
    server_public_key: Buffer.alloc(32, 2).toString("base64"),
    endpoint: "43.139.140.124:51820",
    allowed_ips: ["10.88.0.1/32"],
    persistent_keepalive: 25,
  },
  data_server: {
    url: "http://10.88.0.1:8000",
    api_token: "lxe_dev_0123456789abcdef0123456789abcdef.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
    sync_interval_seconds: 3_600,
  },
  erp: { api_token: "erp-dedicated-secret" },
};

const encryptedEnrollment = (password: string): Buffer => {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const normalized = Buffer.from(password.replace(/-/gu, ""), "ascii");
  const key = scryptSync(normalized, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("lxe-agent-enrollment:v1", "ascii"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(enrollmentPayload)), cipher.final()]);
  return Buffer.from(JSON.stringify({
    format: "lxe-agent-enrollment",
    version: 1,
    kdf: { name: "scrypt", salt: salt.toString("base64"), n: 32_768, r: 8, p: 1 },
    cipher: {
      name: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
  }));
};

describe("DesktopCloudService", () => {
  test("uses an in-memory Preview target on unsupported platforms and prefers it over managed config", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-preview-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    config.saveCloudEnrollment({
      deviceId: "managed-device",
      deviceName: "Managed device",
      vpnIp: "10.88.0.99",
      dataServerUrl: "http://managed.example",
      tunnelName: "lxe-agent",
      apiKey: "managed-secret",
    });
    const previewToken = "preview-admin-secret";
    const previewUrl = "http://10.88.0.1:8000";
    const requests: Array<{ url: string; authorization: string }> = [];
    const events: LogEvent[] = [];
    let configured = 0;
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: false,
      previewTarget: { dataServerUrl: previewUrl, apiToken: previewToken },
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger(events),
      provisioner: { provision: async () => { throw new Error("must not provision WireGuard"); } },
      onConfigured: async () => { configured += 1; },
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: String(new Headers(init?.headers).get("authorization")),
        });
        return Response.json({ status: "ok", role: "admin" });
      },
    });

    expect(service.state()).toMatchObject({
      configured: true,
      connection: "connecting",
      device_id: "",
      vpn_ip: "",
    });
    expect(() => service.select("ignored.lxe-enroll"))
      .toThrow("公司云端仅支持 Windows 10/11 x64 安装包");
    expect(await service.start()).toMatchObject({
      configured: true,
      connection: "connected",
      device_id: "",
      device_name: "",
      vpn_ip: "",
    });
    expect(requests).toEqual([{
      url: `${previewUrl}/api/v1/agent-data/admin/status`,
      authorization: `Bearer ${previewToken}`,
    }]);
    expect(configured).toBe(0);
    expect(events.at(-1)?.fields).toMatchObject({ probe_kind: "admin", http_status: 200 });
    expect(JSON.stringify(service.state())).not.toContain(previewToken);
    expect(JSON.stringify(service.state())).not.toContain(previewUrl);
    expect(JSON.stringify(events)).not.toContain(previewToken);
    expect(JSON.stringify(events)).not.toContain(previewUrl);
  });

  test("never activates a Preview target and rejects a non-admin response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-preview-activation-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: false,
      previewTarget: {
        dataServerUrl: enrollmentPayload.data_server.url,
        apiToken: enrollmentPayload.data_server.api_token,
      },
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => { throw new Error("must not provision WireGuard"); } },
      onConfigured: async () => undefined,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method),
          body: String(init?.body ?? ""),
        });
        return Response.json({ status: "ok", role: "device" });
      },
    });

    expect(await service.check()).toMatchObject({
      connection: "error",
      last_error: "公司云端返回了无效响应",
    });
    expect(requests).toEqual([{
      url: `${enrollmentPayload.data_server.url}/api/v1/agent-data/admin/status`,
      method: "GET",
      body: "",
    }]);
  });

  test("maps a Preview admin credential rejection without exposing the key", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-preview-auth-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    const apiToken = "preview-admin-secret";
    const events: LogEvent[] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: false,
      previewTarget: { dataServerUrl: enrollmentPayload.data_server.url, apiToken },
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger(events),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async () => new Response("Invalid data server API key", { status: 401 }),
    });

    expect(await service.check()).toMatchObject({
      connection: "error",
      last_error: "管理员凭证无效，请检查开发配置",
    });
    expect(events.at(-1)).toMatchObject({
      message: "cloud_status_check_failed",
      fields: { probe_kind: "admin", http_status: 401, connection: "error" },
    });
    expect(JSON.stringify(events)).not.toContain(apiToken);
  });

  test("redacts the Preview URL and token from network diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-preview-redaction-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    const dataServerUrl = "http://10.88.0.1:8000";
    const apiToken = "preview-sensitive-token";
    const events: LogEvent[] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: false,
      previewTarget: { dataServerUrl, apiToken },
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger(events),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async () => {
        throw new Error(`request to ${dataServerUrl} failed for ${apiToken}`);
      },
    });

    expect(await service.check()).toMatchObject({ connection: "offline" });
    expect(events.at(-1)?.fields).toMatchObject({ probe_kind: "admin" });
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain(dataServerUrl);
    expect(serialized).not.toContain(apiToken);
  });

  test("persists a provisioned device while offline and reconnects without reimporting secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-service-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    const enrollments = new DesktopCloudEnrollmentManager();
    const enrollmentPath = join(root, "Finance-PC-01.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    writeFileSync(enrollmentPath, encryptedEnrollment(password));
    let provisioned = 0;
    let restarted = 0;
    let online = false;
    let activated = false;
    const events: LogEvent[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!online) throw new Error("network unavailable");
      if (String(input).endsWith("/devices/status")) {
        return Response.json({
          status: "ok",
          activation_required: !activated,
          device_id: enrollmentPayload.device.id,
          display_name: enrollmentPayload.device.name,
          wireguard_ip: "10.88.0.8",
          machine_id: "",
        });
      }
      const request = JSON.parse(String(init?.body)) as { machine_id: string };
      activated = true;
      return Response.json({
        status: "ok",
        device_id: enrollmentPayload.device.id,
        display_name: enrollmentPayload.device.name,
        wireguard_ip: "10.88.0.8",
        machine_id: request.machine_id,
      });
    };
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger(events),
      provisioner: { provision: async () => { provisioned += 1; } },
      onConfigured: async () => { restarted += 1; },
      fetch,
    });
    const selection = service.select(enrollmentPath);

    const offline = await service.activate({ enrollment_id: selection.enrollment_id, password });

    expect(offline).toMatchObject({ configured: true, connection: "offline", vpn_ip: "10.88.0.8" });
    expect(provisioned).toBe(1);
    expect(restarted).toBe(1);
    expect(config.environment().LXE_DATA_SERVER_API_KEY).toBe(enrollmentPayload.data_server.api_token);
    expect(config.environment().LXE_ERP_API_KEY).toBe(enrollmentPayload.erp?.api_token);
    online = true;
    expect(await service.retry()).toMatchObject({ configured: true, connection: "connected" });
    expect(provisioned).toBe(1);
    expect(events.map(({ message }) => message)).toEqual([
      "cloud_enrollment_activation_started",
      "cloud_enrollment_decrypted",
      "cloud_device_activation_failed",
      "cloud_status_activation_required",
      "cloud_device_activation_completed",
    ]);
    expect(events[2]?.fields).toMatchObject({
      failed_stage: "activate_device",
      connection: "offline",
      observed_error: "network unavailable",
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(enrollmentPayload.wireguard.private_key);
    expect(serialized).not.toContain(enrollmentPayload.data_server.api_token);
    expect(serialized).not.toContain(enrollmentPayload.erp?.api_token ?? "");
  });

  test("logs an enrollment decryption failure without provisioning or exposing the password", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-decrypt-failure-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    const enrollments = new DesktopCloudEnrollmentManager();
    const enrollmentPath = join(root, "Finance-PC-01.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    const wrongPassword = "ZZZZ-ZZZZ-ZZZZ-ZZZZ-9999";
    writeFileSync(enrollmentPath, encryptedEnrollment(password));
    const events: LogEvent[] = [];
    let provisioned = 0;
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger(events),
      provisioner: { provision: async () => { provisioned += 1; } },
      onConfigured: async () => undefined,
    });
    const selection = service.select(enrollmentPath);

    await expect(service.activate({ enrollment_id: selection.enrollment_id, password: wrongPassword }))
      .rejects.toThrow("设备文件或密码不正确");

    expect(provisioned).toBe(0);
    expect(events.map(({ message }) => message)).toEqual([
      "cloud_enrollment_activation_started",
      "cloud_device_activation_failed",
    ]);
    expect(events[1]?.fields).toMatchObject({
      failed_stage: "decrypt_enrollment",
      observed_error: "设备文件或密码不正确",
    });
    expect(JSON.stringify(events)).not.toContain(wrongPassword);
  });

  test("logs an HTTP credential rejection without changing the public cloud state", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-http-rejection-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    const enrollments = new DesktopCloudEnrollmentManager();
    const enrollmentPath = join(root, "Finance-PC-01.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    writeFileSync(enrollmentPath, encryptedEnrollment(password));
    const events: LogEvent[] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger(events),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async () => new Response(null, { status: 403 }),
    });
    const selection = service.select(enrollmentPath);

    const state = await service.activate({ enrollment_id: selection.enrollment_id, password });

    expect(state).toMatchObject({ connection: "error", last_error: "设备凭证已失效，请联系管理员" });
    expect(events.at(-1)).toMatchObject({
      message: "cloud_device_activation_failed",
      fields: { failed_stage: "activate_device", http_status: 403, connection: "error" },
    });
    expect(JSON.stringify(events)).not.toContain(enrollmentPayload.data_server.api_token);
  });

  test("polls authenticated status every interval and stops cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-probe-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    config.saveCloudEnrollment({
      deviceId: enrollmentPayload.device.id,
      deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8",
      dataServerUrl: enrollmentPayload.data_server.url,
      tunnelName: "lxe-agent",
      apiKey: enrollmentPayload.data_server.api_token,
    });
    const machineId = resolveMachineIdentity(join(root, "db", "machine_identity.json")).machine_id;
    const clock = new FakeClock();
    const requests: Array<{ url: string; method: string }> = [];
    const states: string[] = [];
    const events: LogEvent[] = [];
    let now = 1_000;
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger(events),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      onStateChanged: (state) => { states.push(`${state.connection}:${state.last_checked_at}`); },
      clock,
      now: () => now,
      fetch: async (input, init) => {
        requests.push({ url: String(input), method: String(init?.method) });
        return Response.json({
          status: "ok",
          activation_required: false,
          device_id: enrollmentPayload.device.id,
          display_name: enrollmentPayload.device.name,
          wireguard_ip: "10.88.0.8",
          machine_id: machineId,
        });
      },
    });

    expect(await service.start()).toMatchObject({ connection: "connected", last_checked_at: 1 });
    expect(requests).toEqual([{
      url: "http://10.88.0.1:8000/api/v1/agent-data/devices/status",
      method: "GET",
    }]);
    expect(events.at(-1)?.fields).toMatchObject({ probe_kind: "device", http_status: 200 });
    now = 61_000;
    clock.fireIntervals();
    await service.check();
    expect(requests).toHaveLength(2);
    expect(service.state()).toMatchObject({ connection: "connected", last_checked_at: 61 });
    expect(states).toEqual(["connected:1", "connected:61"]);

    await service.stop();
    expect(clock.intervals.size).toBe(0);
  });

  test("coalesces concurrent probes and maps timeout, auth, version, and malformed failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-failures-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    config.saveCloudEnrollment({
      deviceId: enrollmentPayload.device.id,
      deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8",
      dataServerUrl: enrollmentPayload.data_server.url,
      tunnelName: "lxe-agent",
      apiKey: enrollmentPayload.data_server.api_token,
    });
    const clock = new FakeClock();
    let calls = 0;
    let complete: ((response: Response) => void) | undefined;
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      clock,
      fetch: async () => {
        calls += 1;
        return new Promise<Response>((resolve) => { complete = resolve; });
      },
    });

    const first = service.check();
    const second = service.retry();
    expect(first).toBe(second);
    expect(calls).toBe(1);
    complete?.(new Response("missing", { status: 404 }));
    expect(await first).toMatchObject({
      connection: "error",
      last_error: "公司云端版本不兼容，请联系管理员升级服务",
    });

    const responses = [
      new Response("denied", { status: 401 }),
      Response.json({ status: "ok", activation_required: "no" }),
    ];
    const mapped = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async () => responses.shift()!,
    });
    expect(await mapped.check()).toMatchObject({
      connection: "error",
      last_error: "设备凭证已失效，请联系管理员",
    });
    expect(await mapped.check()).toMatchObject({
      connection: "error",
      last_error: "公司云端返回了无效响应",
    });

    const timeoutClock = new FakeClock();
    const timedOut = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      clock: timeoutClock,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    });
    const pending = timedOut.check();
    timeoutClock.fireTimeouts();
    expect(await pending).toMatchObject({ connection: "offline" });
  });
});
