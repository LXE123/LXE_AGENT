import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
import { DesktopConfigStore } from "../src/main/config-store";
import { DesktopCloudService } from "../src/main/desktop-cloud";
import { DesktopCloudEnrollmentManager } from "../src/main/cloud-enrollment";
import { resolveDataServerRuntimeEnvironment } from "../src/main/data-server-policy";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
const adminId = "a".repeat(32);
const rootToken = `lxe_identity_${adminId}.${"s".repeat(43)}`;
const business = { token: `lxe_run_${"b".repeat(43)}`, erp_token: `lxe_erp_run_${"e".repeat(43)}`, expires_at: 4_000_000_000 };
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "lxe-identity-")); roots.push(root);
  const config = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, {
    platform: "darwin", secretEnvironment: { LXE_DATA_SERVER_API_KEY: "inherited-admin-secret" },
  });
  const machine = resolveMachineIdentity(join(root, "db", "machine_identity.json"));
  const identity = { status: "ok", principal_kind: "system_administrator", principal_id: adminId,
    device_id: adminId, display_name: "Mac administrator", wireguard_ip: "10.88.0.2", machine_id: machine.machine_id,
    activation_required: false, registration_status: "active", management_role: "administrator", management_version: 1,
    permission_v2: { response_schema: "lxe.device-permission.v2", assignment_version: 1,
      profile: { id: "replenishment", revision: 2, labels: { "zh-CN": "备货", "en-US": "Replenishment" } },
      grants: { skill_types: ["amazon_replenish", "default"], desktop_features: [] } } };
  return { root, config, identity };
}
function enroll(config: DesktopConfigStore) {
  config.saveCloudEnrollment({ deviceId: adminId, deviceName: "Mac administrator", vpnIp: "10.88.0.2",
    dataServerUrl: "http://10.88.0.1:8000", tunnelName: "", apiKey: rootToken });
}

test("server role controls management while runtime credentials remain scoped in every launch mode", async () => {
  const { root, config, identity } = setup(); enroll(config);
  const requests: string[] = [];
  const code = `lxe_handoff_${"h".repeat(43)}`;
  const service = new DesktopCloudService({ dataRoot: root, config, supported: false,
    logger, enrollments: new DesktopCloudEnrollmentManager(), onConfigured: async () => {},
    provisioner: { provision: async () => { throw new Error("must not provision"); } },
    fetch: async (input, init) => {
      const url = String(input); requests.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${rootToken}`);
      if (url.endsWith("/identity")) return Response.json(identity);
      if (url.endsWith("/business-credential")) return Response.json(business);
      if (url.endsWith("/admin-handoff")) return Response.json({ code, expires_at: 4_000_000_000 });
      throw new Error(`Unexpected identity request: ${url}`);
    },
  });
  try {
    expect(await service.start()).toMatchObject({ connection: "connected", is_admin: true, permission_profile: "replenishment" });
    expect(service.allowedSkillTypes()).toEqual(["amazon_replenish", "default"]);
    expect(await service.adminDashboardUrl()).toBe(`http://10.88.0.1:8000/admin#handoff=${code}`);
    for (const packaged of [false, true]) {
      const environment = resolveDataServerRuntimeEnvironment({ packaged, sourceEnvironment: { LXE_DATA_SERVER_API_KEY: rootToken },
        managedEnvironment: config.environment(), machineIdentityPath: join(root, "db", "machine_identity.json") });
      expect(environment.LXE_DATA_SERVER_API_KEY).toBe(business.token);
      expect(environment.LXE_ERP_API_KEY).toBe(business.erp_token);
      expect(JSON.stringify(environment)).not.toContain(rootToken);
      expect(JSON.stringify(environment)).not.toContain("inherited-admin-secret");
    }
    identity.management_role = "member"; identity.management_version += 1;
    expect(await service.check()).toMatchObject({ is_admin: false, permission_profile: "replenishment" });
    await expect(service.adminDashboardUrl()).rejects.toThrow("管理员身份");
    expect(requests.some((url) => url.includes("/admin/status"))).toBe(false);
  } finally { await service.stop(); }
});

test("an inherited administrator key never configures a desktop identity", async () => {
  const { root, config } = setup();
  const service = new DesktopCloudService({ dataRoot: root, config, supported: true, logger,
    enrollments: new DesktopCloudEnrollmentManager(), provisioner: { provision: async () => {} },
    onConfigured: async () => {}, fetch: async () => { throw new Error("must not connect"); } });
  try {
    expect(await service.start()).toMatchObject({ configured: false, is_admin: false, connection: "not_configured" });
    expect(config.environment().LXE_DATA_SERVER_API_KEY).toBe("");
  } finally { await service.stop(); }
});

test("an encrypted v4 identity file binds an existing tunnel without provisioning or copying WireGuard keys", async () => {
  const { root, config, identity } = setup();
  const password = "ABCDEFGHJKLMNPQR23456";
  const salt = randomBytes(16), nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), nonce);
  cipher.setAAD(Buffer.from("lxe-agent-enrollment:v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ format: "lxe-agent-enrollment-payload", version: 4,
    device: { id: adminId, name: "Mac administrator", principal_kind: "system_administrator" },
    wireguard: { mode: "existing", address: "10.88.0.2/32" },
    data_server: { url: "http://10.88.0.1:8000", api_token: rootToken, sync_interval_seconds: 3600 } })), cipher.final()]);
  const path = join(root, "identity.lxe-enroll");
  writeFileSync(path, JSON.stringify({ format: "lxe-agent-enrollment", version: 1,
    kdf: { name: "scrypt", n: 32768, r: 8, p: 1, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") } }));
  let configured = 0;
  const service = new DesktopCloudService({ dataRoot: root, config, supported: true, logger,
    enrollments: new DesktopCloudEnrollmentManager(), onConfigured: async () => { configured += 1; },
    provisioner: { provision: async () => { throw new Error("Existing tunnel must be preserved"); } },
    fetch: async (input) => String(input).endsWith("/identity/activate") ? Response.json(identity) : Response.json(business),
  });
  try {
    const selected = service.select(path);
    expect(await service.activate({ enrollment_id: selected.enrollment_id, password })).toMatchObject({ is_admin: true, connection: "connected" });
    expect(config.cloudIdentityCredential()).toBe(rootToken);
    expect(config.cloudWireGuardConfiguration()).toBeNull();
    expect(configured).toBe(1);
  } finally { await service.stop(); }
});
