import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
import type { Logger } from "@lxe/core";
import { DesktopConfigStore } from "../src/main/config-store";
import { DesktopCloudService } from "../src/main/desktop-cloud";
import { DesktopCloudEnrollmentManager } from "../src/main/cloud-enrollment";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = "f".repeat(32);
const legacy = `lxe_dev_${id}.${"s".repeat(43)}`;

function fixture(platform: "win32" | "darwin" = "win32") {
  const root = mkdtempSync(join(tmpdir(), "identity-migration-")); roots.push(root);
  let failSave = false;
  let failPromotion = false;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      const secrets = JSON.parse(value);
      if (failSave || (failPromotion && secrets.data_server_api_key.startsWith("lxe_client_"))) throw new Error("disk write failed");
      return Buffer.from(value);
    }, decryptString: (value: Buffer) => value.toString(),
  };
  const configFactory = () => new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform });
  let config = configFactory();
  config.saveCloudEnrollment({ deviceId: id, deviceName: "FBA-upstream", vpnIp: "10.88.0.10",
    dataServerUrl: "http://10.88.0.1:8000", tunnelName: "lxe-agent", apiKey: legacy });
  const machine = resolveMachineIdentity(join(root, "db", "machine_identity.json"));
  const identity = { status: "ok", principal_kind: "managed_device", principal_id: id, device_id: id,
    display_name: "FBA-upstream", wireguard_ip: "10.88.0.10", machine_id: machine.machine_id,
    activation_required: false, registration_status: "active", management_role: "member", management_version: 1,
    permission_v2: { response_schema: "lxe.device-permission.v2", assignment_version: 1,
      profile: { id: "fba", revision: 2, labels: { "zh-CN": "FBA", "en-US": "FBA" } },
      grants: { skill_types: ["fba", "default"], desktop_features: ["erp_dashboard"] } } };
  const business = { token: `lxe_run_${"b".repeat(43)}`, erp_token: `lxe_erp_run_${"e".repeat(43)}`, expires_at: 4_000_000_000 };
  let state: "pending" | "prepared" | "completed" = "pending";
  let candidate = "";
  let loseResponse: "prepare" | "confirm" | "" = "";
  let failHttp = 0;
  let wrongIdentity = false;
  const requests: string[] = [];
  const logs: string[] = [];
  const logger: Logger = { debug() {}, info(m, f) { logs.push(JSON.stringify({ m, f })); },
    warn(m, f) { logs.push(JSON.stringify({ m, f })); }, error() {}, child() { return logger; } };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
    if (url.includes("/migration/")) {
      if (failHttp) return Response.json({ detail: { code: "migration_not_authorized", message: `${legacy} ${candidate}` } }, { status: failHttp });
      const body = JSON.parse(String(init?.body));
      expect(body.machine_id).toBe(machine.machine_id);
      const action = url.split("/").at(-1);
      if (action === "status") {
        if (!candidate) return Response.json({ detail: { code: "invalid_migration_credential" } }, { status: 401 });
        expect(token).toBe(candidate);
      }
      if (action === "prepare") {
        expect(token).toBe(legacy);
        expect(state).not.toBe("completed");
        // Reopen the repository: the candidate must already be durable before preparing it.
        expect(configFactory().cloudMigrationCandidate(legacy)).toBe(body.candidate_token);
        if (candidate) expect(body.candidate_token).toBe(candidate);
        candidate = body.candidate_token; state = "prepared";
      }
      if (action === "confirm") { expect(token).toBe(candidate); state = "completed"; }
      if (loseResponse === action) { loseResponse = ""; throw new Error("connection lost after server commit"); }
      return Response.json({ device_id: wrongIdentity ? "other-device" : id, machine_id: machine.machine_id, state, error_code: "" });
    }
    expect(token).toBe(candidate);
    if (url.endsWith("/identity")) return Response.json(identity);
    if (url.endsWith("/business-credential")) return Response.json(business);
    throw new Error(`Unexpected request ${url}`);
  };
  const serviceFactory = () => new DesktopCloudService({ config, dataRoot: root, supported: true, logger,
    enrollments: new DesktopCloudEnrollmentManager(), provisioner: { provision: async () => { throw new Error("must retain VPN"); } },
    onConfigured: async () => {}, fetch });
  return { serviceFactory, config: () => config, reopen: () => { config = configFactory(); }, state: () => state,
    candidate: () => candidate, business, requests, logs, identity,
    loseResponse: (action: typeof loseResponse) => { loseResponse = action; },
    failSave: (value: boolean) => { failSave = value; }, failPromotion: (value: boolean) => { failPromotion = value; },
    failHttp: (value: number) => { failHttp = value; }, wrongIdentity: () => { wrongIdentity = true; } };
}

for (const platform of ["win32", "darwin"] as const) {
  test(`${platform}: legacy identity migrates once, retains binding, and exports only business tokens`, async () => {
    const f = fixture(platform); const service = f.serviceFactory();
    try {
      const before = f.config().cloudConfiguration();
      const result = await service.start();
      expect(result).toMatchObject({ configured: true, connection: "connected", is_admin: false });
      expect(f.config().cloudIdentityCredential()).toBe(f.candidate());
      expect(f.config().cloudConfiguration()).toMatchObject({ device_id: before.device_id, vpn_ip: before.vpn_ip, tunnel_name: before.tunnel_name });
      expect(f.config().environment().LXE_ERP_API_KEY).toBe(f.business.erp_token);
      const environment = JSON.stringify(f.config().environment());
      expect(environment).not.toContain(f.candidate()); expect(environment).not.toContain(legacy);
      const migrationRequests = f.requests.filter((url) => url.includes("/migration/"));
      await service.check();
      expect(f.requests.filter((url) => url.includes("/migration/"))).toEqual(migrationRequests);
    } finally { await service.stop(); }
  });
}

for (const action of ["prepare", "confirm"] as const) {
  test(`lost ${action} response resumes after process restart with the same candidate`, async () => {
    const f = fixture(); f.loseResponse(action); let service = f.serviceFactory();
    try {
      expect((await service.start()).connection).toBe("error");
      const candidate = f.candidate();
      expect(f.config().cloudLegacyIdentityCredential()).toBe(legacy);
      expect(f.config().environment().LXE_ERP_API_KEY).toBe("");
      await service.stop(); f.reopen(); service = f.serviceFactory();
      expect((await service.start()).connection).toBe("connected");
      expect(f.config().cloudIdentityCredential()).toBe(candidate);
      expect(f.requests.filter((url) => url.endsWith("/prepare"))).toHaveLength(1);
    } finally { await service.stop(); }
  });
}

test("no network request is made until the candidate is safely saved", async () => {
  const f = fixture(); f.failSave(true); const service = f.serviceFactory();
  try {
    expect((await service.start()).connection).toBe("error");
    expect(f.requests).toHaveLength(0);
    expect(f.config().cloudLegacyIdentityCredential()).toBe(legacy);
    f.failSave(false);
    expect((await service.check()).connection).toBe("connected");
  } finally { await service.stop(); }
});

test("server cutover followed by local storage failure recovers without rotating again", async () => {
  const f = fixture(); f.failPromotion(true); let service = f.serviceFactory();
  try {
    expect((await service.start()).connection).toBe("error");
    expect(f.state()).toBe("completed");
    const candidate = f.candidate();
    await service.stop(); f.failPromotion(false); f.reopen(); service = f.serviceFactory();
    expect((await service.start()).connection).toBe("connected");
    expect(f.config().cloudIdentityCredential()).toBe(candidate);
    expect(f.requests.filter((url) => url.endsWith("/confirm"))).toHaveLength(1);
  } finally { await service.stop(); }
});

test("offline or unready server retries and diagnostics redact both identities", async () => {
  const f = fixture(); f.failHttp(404); const service = f.serviceFactory();
  try {
    const result = await service.start();
    expect(result).toMatchObject({ configured: true, connection: "error" });
    expect(result.last_error).toContain("HTTP 404");
    expect(JSON.stringify(result)).not.toContain(legacy);
    expect(f.logs.join("\n")).not.toContain(legacy);
    f.failHttp(0); expect((await service.check()).connection).toBe("connected");
  } finally { await service.stop(); }
});

test("wrong response identity never promotes a candidate", async () => {
  const f = fixture(); f.wrongIdentity(); const service = f.serviceFactory();
  try {
    expect((await service.start()).connection).toBe("error");
    expect(f.config().cloudIdentityCredential()).toBe("");
    expect(f.config().cloudLegacyIdentityCredential()).toBe(legacy);
    expect(f.state()).toBe("prepared");
  } finally { await service.stop(); }
});
