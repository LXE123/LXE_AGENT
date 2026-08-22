import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
import { DesktopCloudEnrollmentManager, type CloudEnrollmentPayload } from "../src/main/cloud-enrollment";
import { DesktopConfigStore } from "../src/main/config-store";
import { DesktopCloudService, type DesktopCloudClock } from "../src/main/desktop-cloud";
import { WireGuardProvisioningError } from "../src/main/wireguard-provisioner";

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
  enrollment_version: 1,
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

const replacementEnrollmentPayload: CloudEnrollmentPayload & { format: string; version: number } = {
  ...enrollmentPayload,
  device: { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Replacement-PC-02" },
  wireguard: {
    ...enrollmentPayload.wireguard,
    private_key: Buffer.alloc(32, 3).toString("base64"),
    address: "10.88.0.9/32",
  },
  data_server: {
    ...enrollmentPayload.data_server,
    api_token: "lxe_dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.abcdefghijklmnopqrstuvwxyzABCDEF",
  },
  erp: { api_token: "replacement-erp-secret" },
};

const devicePermission = (
  permissionProfile: "fba" | "replenishment" | "full_access" | null = "fba",
  permissionVersion = permissionProfile === null ? 0 : 1,
) => ({
  permission_schema: 1 as const,
  permission_profile: permissionProfile,
  permission_version: permissionVersion,
  profile_revision: permissionProfile === null ? 0 : 1,
  profile_labels: permissionProfile === "fba"
    ? { "zh-CN": "FBA", "en-US": "FBA" }
    : permissionProfile === "replenishment"
      ? { "zh-CN": "备货", "en-US": "Replenishment" }
      : permissionProfile === "full_access"
        ? { "zh-CN": "全部业务", "en-US": "Full access" }
        : {},
  allowed_skill_types: permissionProfile === "fba"
    ? ["amazon_fba", "ziniao_browser", "default"]
    : permissionProfile === "replenishment"
      ? ["amazon_replenish", "default"]
      : permissionProfile === "full_access" ? ["*"] : [],
  desktop_features: permissionProfile === "fba" || permissionProfile === "full_access"
    ? ["erp_dashboard"]
    : [],
});

const devicePermissionV2 = (
  profile = "shopee",
  assignmentVersion = 1,
  profileRevision = 1,
  skillTypes: string[] = ["shopee_operations", "default"],
  desktopFeatures: string[] = [],
) => ({
  response_schema: "lxe.device-permission.v2",
  assignment_version: assignmentVersion,
  profile: {
    id: profile,
    revision: profileRevision,
    labels: { "zh-CN": profile === "shopee" ? "Shopee" : profile, "en-US": profile },
  },
  grants: {
    skill_types: skillTypes,
    desktop_features: desktopFeatures,
  },
});

const encryptedEnrollment = (
  password: string,
  payload: CloudEnrollmentPayload & { format: string; version: number } = enrollmentPayload,
): Buffer => {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const normalized = Buffer.from(password.replace(/-/gu, ""), "ascii");
  const key = scryptSync(normalized, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("lxe-agent-enrollment:v1", "ascii"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
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
  test("refreshes changed or invalid managed credentials, retains them offline, and applies revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-managed-llm-"));
    roots.push(root);
    mkdirSync(join(root, "workspace"));
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    const previewUrl = "http://10.88.0.1:8000";
    const previewToken = "preview-admin-secret";
    let revision = "a".repeat(64);
    let apiKey = "managed-key-one";
    let offline = false;
    let available = true;
    const requests: string[] = [];
    const changed: string[] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: false,
      previewTarget: { dataServerUrl: previewUrl, apiToken: previewToken },
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => { throw new Error("must not provision WireGuard"); } },
      onConfigured: async () => undefined,
      onManagedLlmCredentialChanged: (credential) => {
        changed.push(credential?.credential_revision ?? "revoked");
      },
      fetch: async (input) => {
        if (offline) throw new Error("data server offline");
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/admin/status")) {
          return Response.json({
            status: "ok",
            role: "admin",
            managed_llm: available ? {
              available: true,
              provider: "deepseek",
              model: "deepseek-v4-flash",
              credential_revision: revision,
            } : { available: false },
          });
        }
        return Response.json({
          provider: "deepseek",
          model: "deepseek-v4-flash",
          credential_revision: revision,
          api_key: apiKey,
        }, { headers: { "cache-control": "no-store" } });
      },
    });

    await service.start();
    expect(requests).toEqual([
      `${previewUrl}/api/v1/agent-data/admin/status`,
      `${previewUrl}/api/v1/agent-data/admin/llm-credential`,
    ]);
    expect(changed).toEqual(["a".repeat(64)]);
    expect(config.state()).toMatchObject({ complete: true, credential_source: "cloud" });
    expect(config.environment()).toMatchObject({ LXE_MANAGED_LLM_API_KEY: "managed-key-one" });

    await service.check();
    expect(requests.filter((url) => url.endsWith("/llm-credential"))).toHaveLength(1);

    revision = "b".repeat(64);
    apiKey = "managed-key-two";
    await service.check();
    expect(requests.filter((url) => url.endsWith("/llm-credential"))).toHaveLength(2);
    expect(changed).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(config.environment()).toMatchObject({
      LXE_MANAGED_LLM_API_KEY: "managed-key-two",
      LXE_MANAGED_LLM_CREDENTIAL_REVISION: "b".repeat(64),
    });

    offline = true;
    await service.check();
    expect(config.state()).toMatchObject({ complete: true, credential_source: "cloud" });
    expect(config.environment()).toMatchObject({
      LXE_MANAGED_LLM_API_KEY: "managed-key-two",
      LXE_MANAGED_LLM_CREDENTIAL_REVISION: "b".repeat(64),
    });

    offline = false;
    config.invalidateManagedLlmCredential("b".repeat(64));
    apiKey = "managed-key-three";
    await service.check();
    expect(requests.filter((url) => url.endsWith("/llm-credential"))).toHaveLength(2);
    expect(config.environment().LXE_MANAGED_LLM_API_KEY).toBe("managed-key-two");

    revision = "c".repeat(64);
    await service.check();
    expect(requests.filter((url) => url.endsWith("/llm-credential"))).toHaveLength(3);
    expect(config.environment().LXE_MANAGED_LLM_API_KEY).toBe("managed-key-three");

    available = false;
    await service.check();
    expect(changed.at(-1)).toBe("revoked");
    expect(config.state()).toMatchObject({ complete: false, managed_model_configured: false });
    expect(config.environment().LXE_MANAGED_LLM_API_KEY).toBe("");
  });

  test("accepts shipped server targets and refuses unknown providers and models before credential fetch", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-managed-target-"));
    roots.push(root);
    mkdirSync(join(root, "workspace"));
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    let provider = "kimi_coding";
    let model = "kimi-for-coding";
    let revision = "d".repeat(64);
    const credentialRequests: string[] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: false,
      previewTarget: { dataServerUrl: "http://10.88.0.1:8000", apiToken: "preview-admin-secret" },
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => { throw new Error("must not provision WireGuard"); } },
      onConfigured: async () => undefined,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/admin/status")) {
          return Response.json({
            status: "ok",
            role: "admin",
            managed_llm: { available: true, provider, model, credential_revision: revision },
          });
        }
        credentialRequests.push(url);
        return Response.json({
          provider,
          model,
          credential_revision: revision,
          api_key: `key-for-${provider}`,
        });
      },
    });

    await service.start();
    expect(config.state()).toMatchObject({
      complete: true,
      provider: "kimi_coding",
      credential_source: "cloud",
    });
    expect(config.environment()).toMatchObject({
      LXE_MANAGED_LLM_PROVIDER: "kimi_coding",
      LXE_MANAGED_LLM_MODEL: "kimi-for-coding",
      LXE_MANAGED_LLM_API_KEY: "key-for-kimi_coding",
    });

    provider = "deepseek";
    model = "deepseek-v4-flash";
    revision = "f".repeat(64);
    await service.check();
    expect(config.state()).toMatchObject({ provider: "deepseek", credential_source: "cloud" });
    expect(config.environment()).toMatchObject({
      LXE_MANAGED_LLM_PROVIDER: "deepseek",
      LXE_MANAGED_LLM_MODEL: "deepseek-v4-flash",
      LXE_MANAGED_LLM_API_KEY: "key-for-deepseek",
    });

    provider = "openrouter";
    model = "stealth/ox-alpha";
    revision = "a".repeat(64);
    await service.check();
    expect(config.state()).toMatchObject({ provider: "openrouter", credential_source: "cloud" });
    expect(config.environment()).toMatchObject({
      LXE_MANAGED_LLM_PROVIDER: "openrouter",
      LXE_MANAGED_LLM_MODEL: "stealth/ox-alpha",
      LXE_MANAGED_LLM_API_KEY: "key-for-openrouter",
    });

    model = "retired-openrouter-model";
    revision = "b".repeat(64);
    await service.check();
    expect(credentialRequests).toHaveLength(3);
    expect(config.managedLlmCredential()).toBeNull();
    expect(config.managedLlmTarget()).toEqual({
      provider: "openrouter",
      model: "retired-openrouter-model",
    });

    provider = "future_vendor";
    model = "future-model";
    revision = "e".repeat(64);
    await service.check();
    expect(credentialRequests).toHaveLength(3);
    expect(config.managedLlmCredential()).toBeNull();
    expect(config.managedLlmTarget()).toEqual({ provider: "future_vendor", model: "future-model" });
    expect(config.environment()).toMatchObject({
      LXE_MANAGED_LLM_PROVIDER: "future_vendor",
      LXE_MANAGED_LLM_MODEL: "future-model",
      LXE_MANAGED_LLM_API_KEY: "",
    });
    expect(JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8"))).toMatchObject({
      schema_version: 8,
      llm: { managed_target: { provider: "future_vendor", model: "future-model" } },
    });
    expect(readFileSync(join(root, "config", "settings.json"), "utf8"))
      .not.toContain("key-for-kimi_coding");
  });

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
    let role = "admin";
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
        return Response.json({ status: "ok", role });
      },
    });

    expect(service.state()).toMatchObject({
      configured: true,
      connection: "connecting",
      is_admin: false,
      device_id: "",
      vpn_ip: "",
    });
    expect(() => service.select("ignored.lxe-enroll"))
      .toThrow("公司云端仅支持 Windows 10/11 x64 安装包");
    expect(await service.start()).toMatchObject({
      configured: true,
      connection: "connected",
      is_admin: true,
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

    role = "device";
    expect(await service.retry()).toMatchObject({ connection: "error", is_admin: false });
    expect(requests).toHaveLength(2);
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
      is_admin: false,
      last_error: "公司云端权限响应无效：invalid admin status response",
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
      is_admin: false,
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
          permission: devicePermission(),
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
        permission: devicePermission(),
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
    expect(await service.retry()).toMatchObject({
      configured: true,
      connection: "connected",
      permission_status: "verified",
      permission_profile: "fba",
      permission_version: 1,
    });
    expect(service.allowedSkillTypes()).toEqual(["amazon_fba", "ziniao_browser", "default"]);
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

  test("atomically switches an existing managed enrollment and refreshes its permission", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-switch-"));
    roots.push(root);
    mkdirSync(join(root, "workspace"));
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    config.saveCloudEnrollment({
      deviceId: enrollmentPayload.device.id,
      deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8",
      dataServerUrl: enrollmentPayload.data_server.url,
      tunnelName: "lxe-agent",
      apiKey: enrollmentPayload.data_server.api_token,
      erpApiKey: enrollmentPayload.erp?.api_token,
    });
    config.saveCloudPermissionSnapshot({
      device_id: enrollmentPayload.device.id,
      ...devicePermission(),
      verified_at: 100,
    });
    const enrollments = new DesktopCloudEnrollmentManager();
    const enrollmentPath = join(root, "Replacement-PC-02.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    writeFileSync(enrollmentPath, encryptedEnrollment(password, replacementEnrollmentPayload));
    const permissionChanges: string[][] = [];
    const managedCredentialChanges: string[] = [];
    let provisionedDevice = "";
    let restarted = 0;
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger([]),
      provisioner: {
        provision: async (payload) => { provisionedDevice = payload.device.id; },
      },
      onConfigured: async () => { restarted += 1; },
      onPermissionChanged: (allowed) => { permissionChanges.push([...allowed]); },
      onManagedLlmCredentialChanged: (credential) => {
        managedCredentialChanges.push(credential?.credential_revision ?? "revoked");
      },
      fetch: async (input, init) => {
        if (String(input).endsWith("/devices/llm-credential")) {
          return Response.json({
            provider: "deepseek",
            model: "deepseek-v4-flash",
            credential_revision: "e".repeat(64),
            api_key: "replacement-managed-key",
          });
        }
        const request = JSON.parse(String(init?.body)) as { machine_id: string };
        return Response.json({
          status: "ok",
          device_id: replacementEnrollmentPayload.device.id,
          display_name: replacementEnrollmentPayload.device.name,
          wireguard_ip: "10.88.0.9",
          machine_id: request.machine_id,
          permission: devicePermission("replenishment", 1),
          managed_llm: {
            available: true,
            provider: "deepseek",
            model: "deepseek-v4-flash",
            credential_revision: "e".repeat(64),
          },
        });
      },
    });
    const selection = service.select(enrollmentPath);

    const state = await service.activate({ enrollment_id: selection.enrollment_id, password });

    expect(provisionedDevice).toBe(replacementEnrollmentPayload.device.id);
    expect(restarted).toBe(2);
    expect(state).toMatchObject({
      configured: true,
      connection: "connected",
      device_id: replacementEnrollmentPayload.device.id,
      device_name: replacementEnrollmentPayload.device.name,
      vpn_ip: "10.88.0.9",
      permission_profile: "replenishment",
      permission_status: "verified",
    });
    expect(config.environment()).toMatchObject({
      LXE_DATA_SERVER_API_KEY: replacementEnrollmentPayload.data_server.api_token,
      LXE_ERP_API_KEY: replacementEnrollmentPayload.erp?.api_token,
    });
    expect(config.cloudPermissionSnapshot()).toMatchObject({
      device_id: replacementEnrollmentPayload.device.id,
      permission_profile: "replenishment",
    });
    expect(permissionChanges).toEqual([[], ["amazon_replenish", "default"]]);
    expect(managedCredentialChanges).toEqual(["revoked", "e".repeat(64)]);
    expect(config.managedLlmCredential()).toMatchObject({
      api_key: "replacement-managed-key",
      credential_revision: "e".repeat(64),
    });
    expect(config.state()).toMatchObject({
      complete: true,
      credential_source: "cloud",
      managed_model_configured: true,
    });
  });

  test("restores the previous enrollment when replacement fails before removal", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-switch-rollback-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    config.saveCloudEnrollment({
      deviceId: enrollmentPayload.device.id,
      deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8",
      dataServerUrl: enrollmentPayload.data_server.url,
      tunnelName: "lxe-agent",
      apiKey: enrollmentPayload.data_server.api_token,
      erpApiKey: enrollmentPayload.erp?.api_token,
    });
    config.saveCloudPermissionSnapshot({
      device_id: enrollmentPayload.device.id,
      ...devicePermission(),
      verified_at: 100,
    });
    const enrollments = new DesktopCloudEnrollmentManager();
    const enrollmentPath = join(root, "Replacement-PC-02.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    writeFileSync(enrollmentPath, encryptedEnrollment(password, replacementEnrollmentPayload));
    let restarted = 0;
    const permissionChanges: string[][] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger([]),
      provisioner: { provision: async () => { throw new Error("WireGuard replacement tunnel failed"); } },
      onConfigured: async () => { restarted += 1; },
      onPermissionChanged: (allowed) => { permissionChanges.push([...allowed]); },
    });
    const selection = service.select(enrollmentPath);

    await expect(service.activate({ enrollment_id: selection.enrollment_id, password }))
      .rejects.toThrow("WireGuard replacement tunnel failed");

    expect(restarted).toBe(2);
    expect(permissionChanges).toEqual([
      [],
      ["amazon_fba", "ziniao_browser", "default"],
    ]);
    expect(service.state()).toMatchObject({
      configured: true,
      connection: "error",
      device_id: enrollmentPayload.device.id,
      vpn_ip: "10.88.0.8",
      permission_profile: "fba",
      permission_status: "cached",
    });
    expect(config.environment()).toMatchObject({
      LXE_DATA_SERVER_API_KEY: enrollmentPayload.data_server.api_token,
      LXE_ERP_API_KEY: enrollmentPayload.erp?.api_token,
    });
    expect(config.cloudPermissionSnapshot()).toMatchObject({ device_id: enrollmentPayload.device.id });
  });

  test("clears the old binding after removal failure and retries the selected enrollment", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-switch-destructive-failure-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    config.saveCloudEnrollment({
      deviceId: enrollmentPayload.device.id,
      deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8",
      dataServerUrl: enrollmentPayload.data_server.url,
      tunnelName: "lxe-agent",
      apiKey: enrollmentPayload.data_server.api_token,
      erpApiKey: enrollmentPayload.erp?.api_token,
    });
    config.saveCloudPermissionSnapshot({
      device_id: enrollmentPayload.device.id,
      ...devicePermission(),
      verified_at: 100,
    });
    const enrollments = new DesktopCloudEnrollmentManager();
    const enrollmentPath = join(root, "Replacement-PC-02.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    writeFileSync(enrollmentPath, encryptedEnrollment(password, replacementEnrollmentPayload));
    let attempts = 0;
    let restarted = 0;
    const permissionChanges: string[][] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger([]),
      provisioner: {
        provision: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new WireGuardProvisioningError(
              "WireGuard 配置失败（install_tunnel）：new tunnel failed",
              true,
            );
          }
        },
      },
      onConfigured: async () => { restarted += 1; },
      onPermissionChanged: (allowed) => { permissionChanges.push([...allowed]); },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { machine_id: string };
        return Response.json({
          status: "ok",
          device_id: replacementEnrollmentPayload.device.id,
          display_name: replacementEnrollmentPayload.device.name,
          wireguard_ip: "10.88.0.9",
          machine_id: request.machine_id,
          permission: devicePermission("replenishment", 1),
        });
      },
    });
    const selection = service.select(enrollmentPath);

    await expect(service.activate({ enrollment_id: selection.enrollment_id, password }))
      .rejects.toThrow("旧绑定已移除；WireGuard 配置失败");

    expect(restarted).toBe(2);
    expect(permissionChanges).toEqual([[]]);
    expect(service.state()).toMatchObject({
      configured: false,
      connection: "error",
      device_id: "",
      vpn_ip: "",
      permission_status: "pending_verification",
    });
    expect(config.cloudConfiguration()).toMatchObject({
      managed: false,
      switch_in_progress: false,
    });
    expect(config.environment()).toMatchObject({
      LXE_DATA_SERVER_ENABLED: "0",
      LXE_DATA_SERVER_API_KEY: "",
      LXE_ERP_API_KEY: "",
      LXE_MANAGED_LLM_API_KEY: "",
    });
    expect(config.cloudPermissionSnapshot()).toBeNull();

    const retried = await service.activate({ enrollment_id: selection.enrollment_id, password });
    expect(attempts).toBe(2);
    expect(restarted).toBe(3);
    expect(retried).toMatchObject({
      configured: true,
      connection: "connected",
      device_id: replacementEnrollmentPayload.device.id,
    });
  });

  test("clears an interrupted destructive switch during startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-switch-interrupted-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    config.saveCloudEnrollment({
      deviceId: enrollmentPayload.device.id,
      deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8",
      dataServerUrl: enrollmentPayload.data_server.url,
      tunnelName: "lxe-agent",
      apiKey: enrollmentPayload.data_server.api_token,
      erpApiKey: enrollmentPayload.erp?.api_token,
    });
    config.saveCloudPermissionSnapshot({
      device_id: enrollmentPayload.device.id,
      ...devicePermission(),
      verified_at: 100,
    });
    config.beginCloudEnrollmentSwitch();
    let fetched = false;
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async () => {
        fetched = true;
        throw new Error("must not probe an abandoned enrollment");
      },
    });

    expect(await service.start()).toMatchObject({
      configured: false,
      connection: "error",
      device_id: "",
      last_error: expect.stringContaining("切换中断"),
    });
    expect(fetched).toBeFalse();
    expect(config.cloudConfiguration()).toMatchObject({ managed: false, switch_in_progress: false });
    expect(config.cloudPermissionSnapshot()).toBeNull();
    expect(config.environment()).toMatchObject({
      LXE_DATA_SERVER_ENABLED: "0",
      LXE_DATA_SERVER_API_KEY: "",
      LXE_ERP_API_KEY: "",
    });
    await service.stop();
  });

  test("waits for an existing device probe before switching enrollment", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-switch-probe-"));
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
    const enrollments = new DesktopCloudEnrollmentManager();
    const enrollmentPath = join(root, "Replacement-PC-02.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    writeFileSync(enrollmentPath, encryptedEnrollment(password, replacementEnrollmentPayload));
    let releaseProbe = (): void => undefined;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let provisioned = false;
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger([]),
      provisioner: { provision: async () => { provisioned = true; } },
      onConfigured: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).endsWith("/devices/status")) {
          await probeGate;
          return Response.json({
            status: "ok",
            activation_required: false,
            device_id: enrollmentPayload.device.id,
            display_name: enrollmentPayload.device.name,
            wireguard_ip: "10.88.0.8",
            machine_id: machineId,
            permission: devicePermission(),
          });
        }
        const request = JSON.parse(String(init?.body)) as { machine_id: string };
        return Response.json({
          status: "ok",
          device_id: replacementEnrollmentPayload.device.id,
          display_name: replacementEnrollmentPayload.device.name,
          wireguard_ip: "10.88.0.9",
          machine_id: request.machine_id,
          permission: devicePermission("replenishment", 1),
        });
      },
    });
    const probe = service.check();
    const selection = service.select(enrollmentPath);
    const activation = service.activate({ enrollment_id: selection.enrollment_id, password });

    await Promise.resolve();
    expect(provisioned).toBe(false);
    releaseProbe();
    await probe;
    const state = await activation;

    expect(provisioned).toBe(true);
    expect(state).toMatchObject({
      connection: "connected",
      device_id: replacementEnrollmentPayload.device.id,
      permission_profile: "replenishment",
    });
  });

  test("leaves the old binding untouched when the replacement password is wrong", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-decrypt-failure-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    config.saveCloudEnrollment({
      deviceId: enrollmentPayload.device.id,
      deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8",
      dataServerUrl: enrollmentPayload.data_server.url,
      tunnelName: "lxe-agent",
      apiKey: enrollmentPayload.data_server.api_token,
      erpApiKey: enrollmentPayload.erp?.api_token,
    });
    config.saveCloudPermissionSnapshot({
      device_id: enrollmentPayload.device.id,
      ...devicePermission(),
      verified_at: 100,
    });
    const enrollments = new DesktopCloudEnrollmentManager();
    const enrollmentPath = join(root, "Finance-PC-01.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    const wrongPassword = "ZZZZ-ZZZZ-ZZZZ-ZZZZ-9999";
    writeFileSync(enrollmentPath, encryptedEnrollment(password, replacementEnrollmentPayload));
    const events: LogEvent[] = [];
    let provisioned = 0;
    let restarted = 0;
    const permissionChanges: string[][] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger(events),
      provisioner: { provision: async () => { provisioned += 1; } },
      onConfigured: async () => { restarted += 1; },
      onPermissionChanged: (allowed) => { permissionChanges.push([...allowed]); },
    });
    const selection = service.select(enrollmentPath);

    await expect(service.activate({ enrollment_id: selection.enrollment_id, password: wrongPassword }))
      .rejects.toThrow("设备文件或密码不正确");

    expect(provisioned).toBe(0);
    expect(restarted).toBe(0);
    expect(permissionChanges).toEqual([]);
    expect(service.state()).toMatchObject({
      configured: true,
      device_id: enrollmentPayload.device.id,
      vpn_ip: "10.88.0.8",
      permission_profile: "fba",
    });
    expect(config.cloudConfiguration()).toMatchObject({ switch_in_progress: false });
    expect(config.environment()).toMatchObject({
      LXE_DATA_SERVER_API_KEY: enrollmentPayload.data_server.api_token,
      LXE_ERP_API_KEY: enrollmentPayload.erp?.api_token,
    });
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
          permission: devicePermission(),
        });
      },
    });

    expect(await service.start()).toMatchObject({
      connection: "connected",
      is_admin: false,
      last_checked_at: 1,
      permission_status: "verified",
      permission_profile: "fba",
    });
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
      last_error: "公司云端权限响应无效：invalid device status response",
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

  test("uses the encrypted permission snapshot indefinitely while offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-cached-permission-"));
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
    config.saveCloudPermissionSnapshot({
      device_id: enrollmentPayload.device.id,
      ...devicePermission("fba", 7),
      verified_at: 1,
    });
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async () => { throw new Error("offline"); },
    });

    expect(service.state()).toMatchObject({
      permission_status: "cached",
      permission_profile: "fba",
      permission_version: 7,
    });
    expect(await service.check()).toMatchObject({
      connection: "offline",
      permission_status: "cached",
      permission_version: 7,
    });
    expect(service.allowedSkillTypes()).toEqual(["amazon_fba", "ziniao_browser", "default"]);
  });

  test("applies a newer permission version and retains it on malformed or regressed responses", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-permission-refresh-"));
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
    config.saveCloudPermissionSnapshot({
      device_id: enrollmentPayload.device.id,
      ...devicePermission("fba", 2),
      verified_at: 1,
    });
    const machineId = resolveMachineIdentity(join(root, "db", "machine_identity.json")).machine_id;
    const permissions = [
      devicePermission("replenishment", 3),
      devicePermission("fba", 2),
      { ...devicePermission("fba", 3), allowed_skill_types: ["*"] },
    ];
    const updates: string[][] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      onPermissionChanged: (allowed) => { updates.push([...allowed]); },
      fetch: async () => Response.json({
        status: "ok",
        activation_required: false,
        device_id: enrollmentPayload.device.id,
        display_name: enrollmentPayload.device.name,
        wireguard_ip: "10.88.0.8",
        machine_id: machineId,
        permission: permissions.shift(),
      }),
    });

    expect(await service.check()).toMatchObject({
      connection: "connected",
      permission_status: "verified",
      permission_profile: "replenishment",
      permission_version: 3,
    });
    expect(updates).toEqual([["amazon_replenish", "default"]]);

    expect(await service.check()).toMatchObject({
      connection: "error",
      permission_status: "cached",
      permission_profile: "replenishment",
      permission_version: 3,
      last_error: expect.stringContaining("regressed"),
    });
    expect(await service.check()).toMatchObject({
      connection: "error",
      permission_status: "cached",
      permission_profile: "replenishment",
      permission_version: 3,
      last_error: expect.stringContaining("does not match"),
    });
    expect(updates).toHaveLength(1);
    expect(config.cloudPermissionSnapshot()).toMatchObject({
      permission_profile: "replenishment",
      permission_version: 3,
    });
  });

  test("keeps an unassigned device connected but exposes no repository Skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-unassigned-permission-"));
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
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async () => Response.json({
        status: "ok",
        activation_required: false,
        device_id: enrollmentPayload.device.id,
        display_name: enrollmentPayload.device.name,
        wireguard_ip: "10.88.0.8",
        machine_id: machineId,
        permission: devicePermission(null),
      }),
    });

    expect(await service.check()).toMatchObject({
      connection: "connected",
      permission_status: "unassigned",
      permission_profile: null,
      permission_version: 0,
    });
    expect(service.allowedSkillTypes()).toEqual([]);
  });

  test("prefers generic v2 permissions and accepts only versioned profile changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-permission-v2-"));
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
    const permissions = [
      devicePermissionV2("shopee", 1, 1),
      devicePermissionV2("shopee", 1, 2, ["shopee_operations", "default"], ["orders_dashboard"]),
      devicePermissionV2("shopee", 1, 2, ["*"], ["orders_dashboard"]),
      devicePermissionV2("shopee", 1, 1),
    ];
    const observedContracts: string[] = [];
    const service = new DesktopCloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async (_input, init) => {
        observedContracts.push(String(new Headers(init?.headers).get("x-lxe-permission-contract")));
        return Response.json({
          status: "ok",
          activation_required: false,
          device_id: enrollmentPayload.device.id,
          display_name: enrollmentPayload.device.name,
          wireguard_ip: "10.88.0.8",
          machine_id: machineId,
          permission: devicePermission("fba", 99),
          permission_v2: permissions.shift(),
        });
      },
    });

    expect(await service.check()).toMatchObject({
      connection: "connected",
      permission_profile: "shopee",
      permission_version: 1,
      profile_revision: 1,
      profile_labels: { "zh-CN": "Shopee", "en-US": "shopee" },
    });
    expect(service.allowedSkillTypes()).toEqual(["shopee_operations", "default"]);

    expect(await service.check()).toMatchObject({
      connection: "connected",
      profile_revision: 2,
      desktop_features: ["orders_dashboard"],
    });
    expect(await service.check()).toMatchObject({
      connection: "error",
      profile_revision: 2,
      last_error: expect.stringContaining("without a profile revision increase"),
    });
    expect(await service.check()).toMatchObject({
      connection: "error",
      profile_revision: 2,
      last_error: expect.stringContaining("revision regressed"),
    });
    expect(observedContracts).toEqual(["2", "2", "2", "2"]);
  });
});
