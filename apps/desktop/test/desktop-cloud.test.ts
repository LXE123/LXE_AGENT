import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import { DesktopCloudEnrollmentManager, type CloudEnrollmentPayload } from "../src/main/cloud-enrollment";
import { DesktopConfigStore } from "../src/main/config-store";
import { DesktopCloudService } from "../src/main/desktop-cloud";

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
    const events: LogEvent[] = [];
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!online) throw new Error("network unavailable");
      const request = JSON.parse(String(init?.body)) as { machine_id: string };
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
    online = true;
    expect(await service.retry()).toMatchObject({ configured: true, connection: "connected" });
    expect(provisioned).toBe(1);
    expect(events.map(({ message }) => message)).toEqual([
      "cloud_enrollment_activation_started",
      "cloud_enrollment_decrypted",
      "cloud_device_activation_failed",
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
});
