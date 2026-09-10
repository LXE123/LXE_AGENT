import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedTargetKey, type ManagedLlmState, type Logger } from "@lxe/core";
import { DesktopConfigStore } from "../src/main/config-store";
import { DesktopCloudService } from "../src/main/desktop-cloud";
import { DesktopCloudEnrollmentManager } from "../src/main/cloud-enrollment";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
const target = (model: string) => ({ provider: "deepseek", model });
const makeState = (): ManagedLlmState => ({ revision: 1, default_target: target("deepseek-v4-flash"),
  models: ["deepseek-v4-flash", "deepseek-v4-pro"].map((model, i) => ({ ...target(model), available: true, credential_revision: (i ? "b" : "a").repeat(64) })),
  credentials: ["deepseek-v4-flash", "deepseek-v4-pro"].map((model, i) => ({ ...target(model), api_key: "key-" + model, credential_revision: (i ? "b" : "a").repeat(64), fetched_at: 1, invalid_revision: "" })) });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "lxe-managed-v2-")); roots.push(root); mkdirSync(join(root, "workspace"));
  return { root, config: new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" }) };
}
test("cloud selection survives restart/default changes; removal selects default and personal selection stays independent", () => {
  const { root, config } = setup(); let state = makeState();
  config.saveManagedLlmState(state);
  expect(config.state().credential_source).toBe("cloud");
  config.saveRuntimePreference("deepseek", "deepseek-v4-pro", "high", "cloud");
  const restarted = new DesktopConfigStore(root, join(root, "workspace"), safeStorage, { platform: "darwin" });
  expect(restarted.managedLlmTarget()).toEqual(target("deepseek-v4-pro"));
  restarted.saveManagedLlmState({ ...state, revision: 2 });
  expect(restarted.managedLlmTarget()).toEqual(target("deepseek-v4-pro"));
  state = { ...state, revision: 3, models: state.models.slice(0, 1), credentials: state.credentials.slice(0, 1) };
  restarted.saveManagedLlmState(state);
  expect(restarted.environment().AGENT_LLM_MODEL).toBe("deepseek-v4-flash");
  expect(() => restarted.saveRuntimePreference("deepseek", "deepseek-v4-pro", "high", "cloud")).toThrow("unavailable");
  restarted.saveLocalModelCredential({ provider: "deepseek", api_key: "personal" });
  restarted.saveRuntimePreference("deepseek", "deepseek-v4-pro", "high", "local");
  restarted.saveManagedLlmState({ revision: 4, default_target: null, models: [], credentials: [] });
  expect(restarted.environment().AGENT_LLM_CREDENTIAL_SOURCE).toBe("local");
  expect(restarted.environment().AGENT_LLM_MODEL).toBe("deepseek-v4-pro");
  expect(restarted.managedLlmState().credentials).toHaveLength(0);
});
test("v2 sync invalidates known changed keys before fetching and isolates failures while retaining offline cache", async () => {
  const { root, config } = setup(); let state = makeState(); let offline = false; let failPro = false;
  const machine = resolveMachineIdentity(join(root, "db", "machine_identity.json"));
  config.saveCloudEnrollment({ deviceId: "fixture", deviceName: "Fixture", vpnIp: "10.88.0.2",
    dataServerUrl: "http://company.test", tunnelName: "", apiKey: "lxe_client_fixture.test-credential" });
  config.saveCloudBusinessCredential({ token: `lxe_run_${"b".repeat(43)}`, erp_token: `lxe_erp_run_${"e".repeat(43)}`, expires_at: 4_000_000_000 });
  const fetched: string[] = []; const observations: number[] = [];
  const service = new DesktopCloudService({ dataRoot: root, supported: false, config,
    enrollments: new DesktopCloudEnrollmentManager(), logger, provisioner: { provision: async () => undefined }, onConfigured: async () => undefined,
    clock: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} },
    onManagedLlmCredentialChanged: () => { observations.push(config.managedLlmState().credentials.length); },
    fetch: async (input) => {
      if (offline) throw new Error("offline");
      const url = new URL(String(input));
      if (url.pathname.endsWith("/identity")) return Response.json({ status: "ok", principal_kind: "managed_device", principal_id: "fixture",
        device_id: "fixture", display_name: "Fixture", wireguard_ip: "10.88.0.2", machine_id: machine.machine_id,
        activation_required: false, registration_status: "active", management_role: "member", management_version: 1,
        permission_v2: { response_schema: "lxe.device-permission.v2", assignment_version: 1,
          profile: { id: "full_access", revision: 1, labels: { "zh-CN": "全部", "en-US": "All" } },
          grants: { skill_types: ["default"], desktop_features: [] } },
        managed_llm_v2: { ...state, credentials: undefined } });
      const model = url.searchParams.get("model")!; fetched.push(model);
      if (failPro && model.endsWith("pro")) return new Response("unavailable", { status: 503 });
      return Response.json(state.credentials.find((c) => c.model === model));
    } });
  await service.start();
  expect(fetched).toHaveLength(2); expect(config.managedLlmState().credentials).toHaveLength(2);
  await service.check(); expect(fetched).toHaveLength(2);
  offline = true; await service.check(); expect(config.managedLlmState().credentials).toHaveLength(2);
  offline = false; failPro = true; state.revision++;
  state.models[1]!.credential_revision = "c".repeat(64); state.credentials[1]!.credential_revision = "c".repeat(64);
  await service.check();
  expect(config.managedLlmState().credentials.map(managedTargetKey)).toEqual([managedTargetKey(state.models[0]!)]);
  expect(observations).toContain(1);
  failPro = false; await service.check(); expect(config.managedLlmState().credentials).toHaveLength(2);
  config.invalidateManagedLlmCredential("c".repeat(64));
  expect(config.managedLlmState().credentials[0]!.invalid_revision).toBe("");
  expect(config.managedLlmState().credentials[1]!.invalid_revision).toBe("c".repeat(64));
  state = { revision: 4, default_target: null, models: [], credentials: [] }; await service.check();
  expect(config.managedLlmState().credentials).toHaveLength(0); expect(config.state().managed_model_configured).toBe(false);
  service.stop();
});

test("an unsupported default does not silently select a supported alternative", () => {
  const { config } = setup();
  const state = makeState();
  state.default_target = { provider: "future_vendor", model: "future-model" };
  state.models.unshift({ ...state.default_target, available: true, credential_revision: "e".repeat(64) });
  config.saveManagedLlmState(state);
  expect(config.managedLlmTarget()).toEqual(state.default_target);
  expect(config.managedLlmCredential()).toBeNull();
  expect(config.state().managed_model_configured).toBe(false);
  expect(config.state().credential_source).toBe("cloud");
});
