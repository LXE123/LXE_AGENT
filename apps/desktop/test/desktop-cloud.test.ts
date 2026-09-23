import { CloudContextError } from "../src/main/cloud-context";
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
  enrollment_version: 5,
  format: "lxe-agent-enrollment-payload",
  version: 5,
  device: { id: "0123456789abcdef0123456789abcdef", name: "Finance-PC-01", minimum_permission_contract_version: 2 },
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
    api_token: "lxe_client_0123456789abcdef0123456789abcdef.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
    sync_interval_seconds: 3_600,
  },
  erp: { api_token: "erp-dedicated-secret" },
};

const replacementEnrollmentPayload: CloudEnrollmentPayload & { format: string; version: number } = {
  ...enrollmentPayload,
  device: { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Replacement-PC-02", minimum_permission_contract_version: 2 },
  wireguard: {
    ...enrollmentPayload.wireguard,
    private_key: Buffer.alloc(32, 3).toString("base64"),
    address: "10.88.0.9/32",
  },
  data_server: {
    ...enrollmentPayload.data_server,
    api_token: "lxe_client_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.abcdefghijklmnopqrstuvwxyzABCDEF",
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
      ? ["replenishment", "default"]
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

const identityJson = (value: any, init?: ResponseInit): Response => Response.json({
  ...(value.device_id ? { principal_id: value.device_id, principal_kind: "managed_device", registration_status: "active",
    management_role: "member", management_version: 1 } : {}), ...value,
}, init);
const cloudService = (options: ConstructorParameters<typeof DesktopCloudService>[0]): DesktopCloudService => {
  const fetcher = options.fetch;
  let identityResponse: Promise<Response> | undefined;
  const contextClient = options.contextClient ?? { query: async () => {
    if (!identityResponse) throw new Error("offline context fixture");
    const response = await identityResponse;
    if (!response.ok) throw new CloudContextError(await response.clone().text(), "context_http_error", response.status);
    const body = await response.clone().json() as any;
    const v1 = body.permission;
    const permission = body.permission_v2 ?? (v1 ? {
      assignment_version: v1.permission_version,
      profile: v1.permission_profile === null ? null : { id: v1.permission_profile, revision: v1.profile_revision,
        labels: v1.profile_labels },
      grants: { skill_types: v1.allowed_skill_types, desktop_features: v1.desktop_features },
    } : undefined);
    return { response_schema: "lxe.device-context.v1",
      device: { id: body.device_id, kind: body.principal_kind ?? "managed_device", display_name: body.display_name, wireguard_ip: body.wireguard_ip },
      permission: permission ? { ...permission, grants: { server_capabilities: [], erp_actions: [], ...permission.grants } } : null };
  } };
  return new DesktopCloudService({ ...options, contextClient, ...(fetcher ? { fetch: (input, init) => {
    if (String(input).endsWith("/identity/business-credential")) throw new Error("Business credentials must not be requested");
    const response = Promise.resolve(fetcher(input, init));
    if (/\/identity(?:\/activate)?$/u.test(String(input))) {
      identityResponse = response.then((r) => r.clone());
      void identityResponse.catch(() => undefined);
    }
    return response;
  } } : {}) });
};
const configuredIdentity = (config: DesktopConfigStore): void => config.saveCloudEnrollment({
  deviceId: enrollmentPayload.device.id, deviceName: enrollmentPayload.device.name, vpnIp: "10.88.0.8",
  dataServerUrl: enrollmentPayload.data_server.url, tunnelName: "lxe-agent", apiKey: enrollmentPayload.data_server.api_token,
});

describe("DesktopCloudService", () => {
  test("refreshes changed or invalid managed credentials, retains them offline, and applies revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-managed-llm-"));
    roots.push(root);
    mkdirSync(join(root, "workspace"));
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    const previewUrl = "http://10.88.0.1:8000";
    const previewToken = enrollmentPayload.data_server.api_token;
    configuredIdentity(config);
    let revision = "a".repeat(64);
    let apiKey = "managed-key-one";
    let offline = false;
    let available = true;
    const requests: string[] = [];
    const changed: string[] = [];
    const service = cloudService({
      dataRoot: root,
      supported: false,
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
        if (url.endsWith("/identity")) {
          return identityJson({
            status: "ok",
            device_id: enrollmentPayload.device.id, display_name: enrollmentPayload.device.name, wireguard_ip: "10.88.0.8",
            machine_id: resolveMachineIdentity(join(root, "db", "machine_identity.json")).machine_id,
            activation_required: false, permission: devicePermission("full_access"), management_role: "administrator",
            managed_llm: available ? {
              available: true,
              provider: "deepseek",
              model: "deepseek-v4-flash",
              credential_revision: revision,
            } : { available: false },
          });
        }
        return identityJson({
          provider: "deepseek",
          model: "deepseek-v4-flash",
          credential_revision: revision,
          api_key: apiKey,
        }, { headers: { "cache-control": "no-store" } });
      },
    });

    await service.start();
    expect(requests).toEqual([
      `${previewUrl}/api/v1/agent-data/identity`,
      `${previewUrl}/api/v1/agent-data/identity/llm-credential`,
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
    configuredIdentity(config);
    let provider = "kimi_coding";
    let model = "kimi-for-coding";
    let revision = "d".repeat(64);
    const credentialRequests: string[] = [];
    const service = cloudService({
      dataRoot: root,
      supported: false,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => { throw new Error("must not provision WireGuard"); } },
      onConfigured: async () => undefined,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/identity")) {
          return identityJson({
            status: "ok",
            device_id: enrollmentPayload.device.id, display_name: enrollmentPayload.device.name, wireguard_ip: "10.88.0.8",
            machine_id: resolveMachineIdentity(join(root, "db", "machine_identity.json")).machine_id,
            activation_required: false, permission: devicePermission("full_access"), management_role: "administrator",
            managed_llm: { available: true, provider, model, credential_revision: revision },
          });
        }
        credentialRequests.push(url);
        return identityJson({
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
      schema_version: 11,
      llm: { managed_target: { provider: "future_vendor", model: "future-model" } },
    });
    expect(readFileSync(join(root, "config", "settings.json"), "utf8"))
      .not.toContain("key-for-kimi_coding");
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
      if (String(input).endsWith("/identity")) {
        return identityJson({
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
      return identityJson({
        status: "ok",
        device_id: enrollmentPayload.device.id,
        display_name: enrollmentPayload.device.name,
        wireguard_ip: "10.88.0.8",
        machine_id: request.machine_id,
        permission: devicePermission(),
      });
    };
    const service = cloudService({
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
    expect(config.cloudIdentityCredential()).toBe(enrollmentPayload.data_server.api_token);
    expect(config.environment().LXE_ERP_API_KEY).toBeUndefined();
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
    expect(events.filter(({ message }) => message !== "cloud_skill_permission_failed").map(({ message }) => message)).toEqual([
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
    const service = cloudService({
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
        if (String(input).endsWith("/identity/llm-credential")) {
          return identityJson({
            provider: "deepseek",
            model: "deepseek-v4-flash",
            credential_revision: "e".repeat(64),
            api_key: "replacement-managed-key",
          });
        }
        const request = JSON.parse(String(init?.body)) as { machine_id: string };
        return identityJson({
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
    expect(config.environment()).not.toHaveProperty("LXE_DATA_SERVER_API_KEY");
    expect(config.environment()).not.toHaveProperty("LXE_ERP_API_KEY");
    expect(config.environment()).not.toHaveProperty("LXE_SAIHU_MCP_API_KEY");
    expect(config.cloudWireGuardConfiguration()).toMatchObject({
      tunnel_name: "lxe-agent",
      private_key: replacementEnrollmentPayload.wireguard.private_key,
      address: replacementEnrollmentPayload.wireguard.address,
    });
    expect(config.cloudPermissionSnapshot()).toMatchObject({
      device_id: replacementEnrollmentPayload.device.id,
      permission_profile: "replenishment",
    });
    expect(permissionChanges).toEqual([[], ["replenishment", "default"]]);
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
    const service = cloudService({
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
    expect(config.environment()).not.toHaveProperty("LXE_DATA_SERVER_API_KEY");
    expect(config.environment()).not.toHaveProperty("LXE_ERP_API_KEY");
    expect(config.environment()).not.toHaveProperty("LXE_SAIHU_MCP_API_KEY");
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
    const service = cloudService({
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
        return identityJson({
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
    });
    config.saveCloudPermissionSnapshot({
      device_id: enrollmentPayload.device.id,
      ...devicePermission(),
      verified_at: 100,
    });
    config.beginCloudEnrollmentSwitch();
    let fetched = false;
    const service = cloudService({
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
    const service = cloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments,
      logger: testLogger([]),
      provisioner: { provision: async () => { provisioned = true; } },
      onConfigured: async () => undefined,
      fetch: async (input, init) => {
        if (String(input).endsWith("/identity")) {
          await probeGate;
          return identityJson({
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
        return identityJson({
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
    const service = cloudService({
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
    expect(config.environment()).not.toHaveProperty("LXE_DATA_SERVER_API_KEY");
    expect(config.environment()).not.toHaveProperty("LXE_ERP_API_KEY");
    expect(config.environment()).not.toHaveProperty("LXE_SAIHU_MCP_API_KEY");
    expect(events.filter(({ message }) => message !== "cloud_skill_permission_failed").map(({ message }) => message)).toEqual([
      "cloud_enrollment_activation_started",
      "cloud_device_activation_failed",
    ]);
    expect(events[1]?.fields).toMatchObject({
      failed_stage: "decrypt_enrollment",
      observed_error: "设备文件或密码不正确",
    });
    expect(JSON.stringify(events)).not.toContain(wrongPassword);
  });

  test.each([
    [JSON.stringify({ detail: { code: "future_error", user_message: "New activation hint", message: "Diagnostic" } }), "New activation hint"],
    [JSON.stringify({ detail: { code: "device_permission_contract_incompatible", required_version: 2, observed_version: 1, message: "Upgrade required" } }), "当前 Agent 版本过旧，请升级后重试"],
    [JSON.stringify({ detail: { code: "device_already_bound", message: "Do not render this raw message" } }), "该设备文件已绑定到另一台电脑"],
    ["not JSON", "该设备文件已绑定到另一台电脑"],
    [JSON.stringify({ detail: null }), "该设备文件已绑定到另一台电脑"],
  ])("maps protocol errors without exposing raw server messages (%s)", async (body, expected) => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-protocol-rejection-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    const enrollmentPath = join(root, "Finance-PC-01.lxe-enroll");
    const password = "ABCD-EFGH-JKLM-NPQR-2345";
    writeFileSync(enrollmentPath, encryptedEnrollment(password));
    const events: LogEvent[] = [];
    const service = cloudService({
      dataRoot: root, supported: true, config, enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger(events), provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined, fetch: async () => new Response(body, { status: 409 }),
    });
    const selection = service.select(enrollmentPath);
    const state = await service.activate({ enrollment_id: selection.enrollment_id, password });
    expect(state).toMatchObject({ connection: "error", last_error: expected });
    expect(events.findLast(event => event.message === "cloud_device_activation_failed")?.fields)
      .toMatchObject({ http_status: 409, observed_error: body });
    expect(state.last_error).not.toContain("Do not render");
  });

  test.each([401, 403, 409, 503])("server hints do not alter HTTP %i connection or credentials", async status => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-custom-hint-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    config.saveCloudEnrollment({ deviceId: enrollmentPayload.device.id, deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8", dataServerUrl: enrollmentPayload.data_server.url, tunnelName: "lxe-agent", apiKey: enrollmentPayload.data_server.api_token });
    const events: LogEvent[] = [];
    let hint = "Server user hint";
    const service = cloudService({ dataRoot: root, supported: true, config, enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger(events), provisioner: { provision: async () => undefined }, onConfigured: async () => undefined,
      contextClient: { query: async () => ({
        response_schema: "lxe.device-context.v1",
        device: { id: enrollmentPayload.device.id, kind: "managed_device", display_name: enrollmentPayload.device.name, wireguard_ip: "10.88.0.8" },
        permission: { ...devicePermissionV2(), grants: { ...devicePermissionV2().grants, server_capabilities: [], erp_actions: [] } },
      }) },
      fetch: async () => Response.json({ detail: { code: "future_error", message: "Original diagnostic", user_message: hint } }, { status }),
    });
    const before = config.cloudIdentityCredential();
    expect(await service.check()).toMatchObject({ connection: status >= 500 ? "offline" : "error", last_error: hint,
      permission_status: "verified", permission_error: "", permission_profile: "shopee" });
    hint = "Updated hint without a client release";
    expect(await service.check()).toMatchObject({ connection: status >= 500 ? "offline" : "error", last_error: hint,
      permission_status: "verified", permission_error: "", permission_profile: "shopee" });
    expect(config.cloudIdentityCredential()).toBe(before);
    expect(service.allowedSkillTypes()).toEqual(["shopee_operations", "default"]);
    const identityError = events.findLast(event => event.message === "cloud_status_check_failed");
    expect(identityError?.fields).toMatchObject({ http_status: status, error_code: "future_error" });
    expect(identityError?.fields.observed_error).toContain("Original diagnostic");
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
    const service = cloudService({
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
    expect(events.findLast(({ message }) => message === "cloud_device_activation_failed")).toMatchObject({
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
    const service = cloudService({
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
        return identityJson({
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
      url: "http://10.88.0.1:8000/api/v1/agent-data/identity",
      method: "GET",
    }]);
    expect(events.at(-1)?.fields).toMatchObject({ probe_kind: "identity", http_status: 200 });
    now = 61_000;
    clock.fireIntervals();
    await service.check();
    expect(requests).toHaveLength(2);
    expect(service.state()).toMatchObject({ connection: "connected", last_checked_at: 61 });
    expect([...new Set(states.filter((state) => state.startsWith("connected:")))]).toEqual(["connected:1", "connected:61"]);

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
    const service = cloudService({
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
      identityJson({ status: "ok", activation_required: "no" }),
    ];
    const mapped = cloudService({
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
    const timedOut = cloudService({
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
    const service = cloudService({
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
      { ...devicePermission("fba", 3), allowed_skill_types: ["*", "default"] },
    ];
    const updates: string[][] = [];
    const service = cloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      onPermissionChanged: (allowed) => { updates.push([...allowed]); },
      fetch: async () => identityJson({
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
    expect(updates).toEqual([["replenishment", "default"]]);

    expect(await service.check()).toMatchObject({
      connection: "connected",
      permission_status: "cached",
      permission_profile: "replenishment",
      permission_version: 3,
      permission_error: expect.stringContaining("regressed"),
    });
    expect(await service.check()).toMatchObject({
      connection: "connected",
      permission_status: "cached",
      permission_profile: "replenishment",
      permission_version: 3,
      permission_error: expect.stringContaining("wildcard"),
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
    const service = cloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async () => identityJson({
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
    const service = cloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: { provision: async () => undefined },
      onConfigured: async () => undefined,
      fetch: async (_input, init) => {
        observedContracts.push(String(new Headers(init?.headers).get("x-lxe-permission-contract")));
        return identityJson({
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
      connection: "connected",
      profile_revision: 2,
      permission_error: expect.stringContaining("without a profile revision increase"),
    });
    expect(await service.check()).toMatchObject({
      connection: "connected",
      profile_revision: 2,
      permission_error: expect.stringContaining("revision regressed"),
    });
    expect(observedContracts).toEqual(["2", "2", "2", "2"]);
  });

  test("publishes Mac dependency setup progress without probing or activating", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-mac-dependencies-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    const published: string[] = [];
    const service = cloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: {
        dependencyStatus: () => ({ state: "homebrew_missing", error: "" }),
        prepareDependencies: async (onChanged) => {
          onChanged({ state: "installing_homebrew", error: "" });
          onChanged({ state: "installing_wireguard_tools", error: "" });
          return { state: "ready", error: "" };
        },
        provision: async () => undefined,
      },
      onConfigured: async () => undefined,
      onStateChanged: (state) => published.push(state.dependency_state),
      fetch: async () => { throw new Error("dependency setup must not probe"); },
    });

    expect(service.state()).toMatchObject({
      connection: "not_configured",
      dependency_state: "homebrew_missing",
    });
    expect(await service.prepareDependencies()).toMatchObject({
      connection: "not_configured",
      dependency_state: "ready",
      dependency_error: "",
    });
    expect(published).toEqual(["installing_homebrew", "installing_wireguard_tools", "ready"]);
  });

  test("reconnects a persisted Mac tunnel only for an explicit retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cloud-mac-reconnect-"));
    roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
    config.saveCloudEnrollment({
      deviceId: enrollmentPayload.device.id,
      deviceName: enrollmentPayload.device.name,
      vpnIp: "10.88.0.8",
      dataServerUrl: enrollmentPayload.data_server.url,
      tunnelName: "lxe-agent",
      apiKey: enrollmentPayload.data_server.api_token,
      wireGuard: {
        tunnel_name: "lxe-agent",
        ...enrollmentPayload.wireguard,
      },
    });
    const machineId = resolveMachineIdentity(join(root, "db", "machine_identity.json")).machine_id;
    const sequence: string[] = [];
    const service = cloudService({
      dataRoot: root,
      supported: true,
      config,
      enrollments: new DesktopCloudEnrollmentManager(),
      logger: testLogger([]),
      provisioner: {
        dependencyStatus: () => ({ state: "ready", error: "" }),
        provision: async () => undefined,
        reconnect: async (configuration) => {
          expect(configuration.private_key).toBe(enrollmentPayload.wireguard.private_key);
          sequence.push("reconnect");
        },
      },
      onConfigured: async () => undefined,
      fetch: async () => {
        sequence.push("probe");
        return identityJson({
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

    expect(await service.start()).toMatchObject({ connection: "connected" });
    expect(sequence).toEqual(["probe"]);
    sequence.length = 0;
    expect(await service.retry()).toMatchObject({ connection: "connected" });
    expect(sequence).toEqual(["reconnect", "probe"]);
    await service.stop();
    expect(sequence).toEqual(["reconnect", "probe"]);
  });
});

describe("independent CLI skill permissions", () => {
  function fixture(enrolled = true) {
    const root = mkdtempSync(join(tmpdir(), "lxe-skill-context-service-")); roots.push(root);
    const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "win32" });
    if (enrolled) configuredIdentity(config);
    const context = (skills = ["amazon_fba"], version = 1) => ({
      response_schema: "lxe.device-context.v1",
      device: { id: enrollmentPayload.device.id, kind: "managed_device", display_name: "Finance PC", wireguard_ip: "10.88.0.8" },
      permission: { ...devicePermissionV2("custom", version, 1, skills), grants: { skill_types: skills, desktop_features: [], server_capabilities: [], erp_actions: [] } },
    });
    const updates: string[][] = [];
    let query: (url: string, signal: AbortSignal) => Promise<unknown> = async () => context();
    let identityFetch: typeof fetch = async () => Response.json({ detail: "identity credential expired" }, { status: 401 });
    const make = (clock?: DesktopCloudClock, supported = true) => new DesktopCloudService({ dataRoot: root, config, supported, clock,
      logger: testLogger([]), provisioner: { provision: async () => {} }, enrollments: new DesktopCloudEnrollmentManager(),
      onConfigured: async () => {}, onPermissionChanged: (skills) => { updates.push([...skills]); },
      contextClient: { query: (url, signal) => query(url, signal) }, fetch: (input, init) => identityFetch(input, init),
    });
    return { root, config, context, updates, make,
      setQuery: (next: typeof query) => { query = next; }, setIdentity: (next: typeof fetch) => { identityFetch = next; } };
  }
  test("unbound discovery polls even when enrollment tooling is unsupported", async () => {
    const f = fixture(false), clock = new FakeClock();
    let queries = 0;
    f.setQuery(async () => { queries++; return f.context(); });
    const service = f.make(clock, false);
    expect(await service.start()).toMatchObject({ permission_status: "verified", connection: "unsupported" });
    expect(queries).toBe(1);
    clock.fireIntervals();
    await service.check();
    expect(queries).toBe(2);
    await service.stop();
    clock.fireIntervals();
    expect(queries).toBe(2);
  });
  test("enrollment switching withholds the native URL and cancels permission discovery", async () => {
    const f = fixture();
    f.config.beginCloudEnrollmentSwitch();
    expect(f.config.environment().LXE_DATA_SERVER_URL).toBe("");
    // Constructor recovers interrupted switches; use the live service for an active switch.
    f.config.abortCloudEnrollmentSwitch();
    const service = f.make();
    f.config.beginCloudEnrollmentSwitch();
    let queries = 0;
    f.setQuery(async () => { queries++; return f.context(); });
    await service.check();
    expect(queries).toBe(0);
    await service.stop();
  });
  test("fresh directory discovers all grants without enrollment, identity fetch or provisioning", async () => {
    const f = fixture(false);
    f.setIdentity(async () => { throw new Error("must not call identity APIs"); });
    f.setQuery(async url => {
      expect(url).toBe("http://10.88.0.1:8000");
      const c = f.context(["replenishment"]);
      c.device.kind = "system_administrator";
      c.permission.grants = { ...c.permission.grants, desktop_features: ["erp_dashboard"], server_capabilities: ["erp", "mabang_read"], erp_actions: ["purchase_import"] };
      return c;
    });
    const service = f.make();
    expect(await service.start()).toMatchObject({ configured: false, is_admin: false, permission_status: "verified",
      desktop_features: ["erp_dashboard"], device_context: { server_url: "http://10.88.0.1:8000", skill_types: ["replenishment"], server_capabilities: ["erp", "mabang_read"], erp_actions: ["purchase_import"] } });
    expect(f.config.cloudConfiguration().managed).toBe(false);
    expect(f.config.cloudIdentityCredential()).toBe("");
    expect(f.config.environment()).toMatchObject({ LXE_DATA_SERVER_URL: "http://10.88.0.1:8000", LXE_DATA_SERVER_ENABLED: "0" });
    await expect(service.erpDashboardUrl()).rejects.toThrow("登录凭据");
    await service.stop();
    f.setQuery(async () => { throw new CloudContextError("offline", "cloud_connection_failed"); });
    const restarted = f.make();
    expect(await restarted.check()).toMatchObject({ permission_status: "cached", device_context: { server_capabilities: ["erp", "mabang_read"] } });
    expect(restarted.allowedSkillTypes()).toEqual(["replenishment"]);
    await restarted.stop();
  });
  test("discovered identity changes clear grants and require a fresh matching confirmation", async () => {
    const f = fixture(false), service = f.make();
    await service.check();
    const changed = (id: string) => ({ ...f.context(["replenishment"]), device: { ...f.context().device, id } });
    f.setQuery(async () => changed("B"));
    expect(await service.check()).toMatchObject({ permission_status: "denied", device_context: { pending_device: { id: "B" } } });
    expect(f.config.cloudPermissionSnapshot()).toBeNull();
    expect(service.allowedSkillTypes()).toEqual([]);
    expect(f.config.cloudObservedDevice()?.id).toBe(enrollmentPayload.device.id);
    f.setQuery(async () => changed("C"));
    expect(await service.confirmDevice()).toMatchObject({ permission_status: "denied", device_context: { pending_device: { id: "C" } } });
    expect(await service.confirmDevice()).toMatchObject({ permission_status: "verified", device_context: { device: { id: "C" }, pending_device: null } });
    expect(f.config.cloudConfiguration().managed).toBe(false);
    await service.stop();
  });
  test("denial keeps remembered identity but clears persistent grants across restarts", async () => {
    const f = fixture(false), service = f.make();
    await service.check();
    f.setQuery(async () => { throw new CloudContextError("revoked", "denied", 403); });
    expect(await service.check()).toMatchObject({ permission_status: "denied" });
    await service.stop();
    f.setQuery(async () => { throw new CloudContextError("offline", "cloud_connection_failed"); });
    const restarted = f.make();
    expect(await restarted.check()).toMatchObject({ permission_status: "pending_verification" });
    expect(restarted.allowedSkillTypes()).toEqual([]);
    expect(f.config.cloudObservedDevice()?.id).toBe(enrollmentPayload.device.id);
    await restarted.stop();
  });
  test("business grants cannot change under the same published version", async () => {
    const f = fixture(false), service = f.make();
    await service.check();
    f.setQuery(async () => { const c = f.context(); c.permission.grants.server_capabilities = ["saihu"]; return c; });
    expect(await service.check()).toMatchObject({ permission_status: "cached", permission_error: "device permission content changed without a profile revision increase" });
    expect(service.state().device_context?.server_capabilities).toEqual([]);
    await service.stop();
  });
  test("stopping discovery ignores a late result and coalesces callers", async () => {
    const f = fixture(false);
    let resolve!: (value: unknown) => void;
    let queries = 0;
    f.setQuery(() => { queries++; return new Promise(r => { resolve = r; }); });
    const service = f.make();
    const first = service.check(), second = service.check();
    expect(first).toBe(second);
    const stopped = service.stop();
    resolve(f.context());
    await Promise.all([first, stopped]);
    expect(queries).toBe(1);
    expect(f.config.cloudPermissionSnapshot()).toBeNull();
  });
  test("identity refusal does not block CLI skill discovery or server address", async () => {
    const f = fixture(), service = f.make();
    expect(await service.check()).toMatchObject({ connection: "error", permission_status: "verified", permission_profile: "custom", is_admin: false });
    expect(service.allowedSkillTypes()).toEqual(["amazon_fba"]);
    expect(f.config.environment()).toMatchObject({ LXE_DATA_SERVER_URL: enrollmentPayload.data_server.url, LXE_DATA_SERVER_ENABLED: "1" });
    f.config.cloudIdentityCredential = () => "";
    expect(await service.check()).toMatchObject({ permission_status: "verified", permission_profile: "custom" });
    await service.stop();
  });
  test("a temporary transport failure without cache remains pending, not denied", async () => {
    const f = fixture();
    f.setQuery(async () => { throw new CloudContextError("connection refused", "cloud_connection_failed"); });
    const service = f.make();
    expect(await service.check()).toMatchObject({ permission_status: "pending_verification", permission_error: "connection refused" });
    expect(service.allowedSkillTypes()).toEqual([]);
    await service.stop();
  });
  test("native grants override identity permissions without requesting business credentials", async () => {
    const f = fixture();
    const identityRequests: string[] = [];
    f.setIdentity(async (input) => { identityRequests.push(String(input)); return identityJson({ status: "ok", activation_required: false, device_id: enrollmentPayload.device.id,
        display_name: enrollmentPayload.device.name, wireguard_ip: "10.88.0.8",
        machine_id: resolveMachineIdentity(join(f.root, "db", "machine_identity.json")).machine_id,
        permission_v2: devicePermissionV2("full_access", 99, 1, ["*"]), managed_llm: { available: false } }); });
    const service = f.make();
    expect(await service.check()).toMatchObject({ connection: "connected", permission_status: "verified", permission_profile: "custom" });
    expect(service.allowedSkillTypes()).toEqual(["amazon_fba"]);
    expect(f.config.environment().LXE_DATA_SERVER_URL).toBe(enrollmentPayload.data_server.url);
    expect(identityRequests.some(url => url.includes("business-credential"))).toBe(false);
    await service.stop();
  });
  test("retains offline cache, applies revocation, persists denial and never restores it on restart", async () => {
    const f = fixture(), service = f.make();
    await service.check();
    f.setQuery(async () => { throw new Error("actual offline error"); });
    expect(await service.check()).toMatchObject({ permission_status: "cached", permission_error: "actual offline error" });
    expect(service.allowedSkillTypes()).toEqual(["amazon_fba"]);
    f.setQuery(async () => f.context([], 2));
    await service.check();
    expect(service.allowedSkillTypes()).toEqual([]);
    f.setQuery(async () => f.context(["replenishment"], 3));
    await service.check();
    f.setQuery(async () => { throw new CloudContextError("device is disabled", "business_device_denied", 403); });
    expect(await service.check()).toMatchObject({ permission_status: "denied", permission_error: "device is disabled" });
    expect(f.config.cloudPermissionSnapshot()).toBeNull();
    expect(service.allowedSkillTypes()).toEqual([]);
    await service.stop();
    f.setQuery(async () => { throw new Error("offline after restart"); });
    const restarted = f.make();
    await restarted.check();
    expect(restarted.allowedSkillTypes()).toEqual([]);
    expect(f.updates).toEqual([["amazon_fba"], [], ["replenishment"], []]);
    await restarted.stop();
  });
  test("identity mismatch clears grants, unassigned versions remain monotonic", async () => {
    const f = fixture(), service = f.make();
    await service.check();
    f.setQuery(async () => ({ ...f.context(), device: { ...f.context().device, id: "other-device" } }));
    expect(await service.check()).toMatchObject({ permission_status: "denied" });
    expect(f.config.cloudPermissionSnapshot()).toBeNull();
    f.setQuery(async () => ({ ...f.context([], 7), permission: { ...f.context([], 7).permission, profile: null } }));
    expect(await service.check()).toMatchObject({ permission_status: "unassigned", permission_version: 7 });
    expect(f.config.cloudPermissionSnapshot()?.permission_version).toBe(7);
    await service.stop();
  });
  test("coalesces queries and ignores a response after binding changes", async () => {
    const f = fixture(); let finish!: (value: unknown) => void; let calls = 0;
    f.setQuery(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
    const service = f.make();
    const first = service.check(), second = service.check();
    expect(first).toBe(second); expect(calls).toBe(1);
    f.config.clearCloudEnrollment();
    finish(f.context());
    await first;
    expect(f.config.cloudPermissionSnapshot()).toBeNull();
    expect(service.allowedSkillTypes()).toEqual([]);
    await service.stop();
  });
});
