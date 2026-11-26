import type { Logger, ManagedLlmState } from "@lxe/core";
import { managedTargetKey, parseManagedManifest } from "@lxe/core";
import type { DesktopNativeCloudAccess, DesktopObservedDevice, ManagedLlmCredential } from "@lxe/desktop-protocol";
import type { DesktopConfigStore } from "../config-store";
import { CloudHttpError } from "./cloud-errors";
import { CloudContextError, contextDiagnostic } from "./cloud-context";
import { sameObservedDevice } from "./cloud-permissions";
import { managedLlmTargetSupported, parseManagedLlmCredential } from "./managed-llm";
import type { NativeCloudClient } from "./native-cloud-client";

export class NativeIdentityChanged extends Error {}
const record = (v: unknown): Record<string, any> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;

export class NativeCloudAccess {
  private value: DesktopNativeCloudAccess = { status: "pending", model_status: "pending", last_error: "", verified_at: 0, is_admin: false };
  private controller: AbortController | undefined;
  private device: DesktopObservedDevice | null = null;
  private epoch = 0;
  constructor(private readonly options: {
    config: DesktopConfigStore; client: NativeCloudClient; logger: Logger; llmConfigRoot: string;
    now: () => number; changed: (value: ManagedLlmCredential | null) => Promise<void> | void;
  }) {
    this.value.verified_at = options.config.managedLlmVerifiedAt();
  }

  state(): DesktopNativeCloudAccess { return { ...this.value }; }
  cancel(): void {
    this.epoch++; this.controller?.abort(); this.controller = undefined;
    this.value = { ...this.value, status: "pending", is_admin: false };
  }
  private async save(state: ManagedLlmState, device: DesktopObservedDevice): Promise<void> {
    const previous = this.options.config.managedLlmState();
    const before = JSON.stringify(previous);
    this.options.config.saveManagedLlmOwner(device, Math.floor(this.options.now() / 1000));
    if (before !== JSON.stringify(state)) {
      this.options.config.saveManagedLlmState(state);
      await this.options.changed(this.options.config.managedLlmCredential());
    }
  }
  async clear(): Promise<void> {
    this.cancel(); this.device = null;
    this.options.config.clearManagedLlmCredential();
    this.options.config.saveManagedLlmOwner(null);
    this.value.model_status = "unavailable";
    await this.options.changed(null);
  }
  private assertDevice(value: unknown, expected: DesktopObservedDevice): void {
    const d = record(value);
    if (!d || !sameObservedDevice({ ...d, server_url: expected.server_url } as DesktopObservedDevice, expected)) {
      throw new NativeIdentityChanged("Device identity changed during cloud access");
    }
  }

  async sync(device: DesktopObservedDevice): Promise<void> {
    this.cancel();
    const epoch = this.epoch;
    const controller = new AbortController(); this.controller = controller;
    const current = () => epoch === this.epoch && !controller.signal.aborted;
    const assertCurrent = () => { if (!current()) throw new Error("Native cloud request cancelled"); };
    this.device = device;
    this.value.status = "checking";
    try {
      const owner = this.options.config.managedLlmOwner();
      if (owner && !sameObservedDevice(owner, device)) {
        this.options.config.clearManagedLlmCredential();
        this.options.config.saveManagedLlmOwner(null);
        await this.options.changed(null); assertCurrent();
      }
      const status = await this.options.client.request(device.server_url, "/api/v1/device-access", controller.signal);
      assertCurrent(); this.assertDevice(status?.device, device);
      if (status.response_schema !== "lxe.device-access.v1"
        || !["administrator", "member"].includes(status.management_role)
        || !Number.isSafeInteger(status.management_version) || status.management_version < 1) throw new Error("Invalid native cloud status");
      const manifest = parseManagedManifest(status.managed_llm_v3 ?? status.managed_llm_v2);
      const cached = this.options.config.managedLlmState();
      const next: ManagedLlmState = { ...manifest, credentials: cached.credentials.filter(c =>
        manifest.models.some(m => m.available && managedTargetKey(m) === managedTargetKey(c)
          && m.credential_revision === c.credential_revision && managedLlmTargetSupported(this.options.llmConfigRoot, m, { ...manifest, credentials: [] }))) };
      await this.save(next, device); assertCurrent(); // Remove revoked revisions before requesting replacements.
      this.value = { ...this.value, status: "connected", is_admin: status.management_role === "administrator",
        verified_at: Math.floor(this.options.now() / 1000), last_error: "", model_status: "unavailable" };
      let modelError: unknown;
      for (const model of manifest.models) {
        if (!model.available || !model.credential_revision || !managedLlmTargetSupported(this.options.llmConfigRoot, model, { ...manifest, credentials: [] })
          || next.credentials.some(c => managedTargetKey(c) === managedTargetKey(model))) continue;
        const query = new URLSearchParams({ provider: model.provider, model: model.model, model_schema: String(manifest.model_schema ?? 2) });
        try {
          const result = await this.options.client.request(device.server_url, "/api/v1/device-access/llm-credential?" + query, controller.signal);
          assertCurrent(); this.assertDevice(result?.device, device);
          const credential = parseManagedLlmCredential(result.credential, { ...model, available: true, credential_revision: model.credential_revision }, this.options.now());
          next.credentials.push(credential);
          await this.save(next, device); assertCurrent();
        } catch (error) {
          assertCurrent();
          if (error instanceof NativeIdentityChanged || (error instanceof CloudHttpError && [401, 403].includes(error.httpStatus))) throw error;
          modelError ??= error;
          this.logFailure(error);
        }
      }
      if (modelError) {
        this.value.last_error = modelError instanceof Error ? modelError.message : contextDiagnostic(String(modelError));
      }
      this.value.model_status = next.credentials.length ? (modelError ? "cached" : "ready") :
        modelError instanceof CloudHttpError && modelError.detail.code === "agent_upgrade_required" ? "upgrade_required" :
        manifest.models.some(m => m.unavailable_reason === "agent_upgrade_required") ? "upgrade_required" : "unavailable";
    } catch (error) {
      if (!current()) return;
      await this.failed(error);
      if (error instanceof NativeIdentityChanged) throw error;
    }
  }

  async failed(error: unknown): Promise<void> {
    const http = error instanceof CloudHttpError ? error.httpStatus : error instanceof CloudContextError ? error.httpStatus : undefined;
    const denied = http === 401 || http === 403 || error instanceof NativeIdentityChanged;
    if (denied) await this.clear();
    else this.cancel();
    const temporary = http !== undefined ? http >= 500 :
      error instanceof CloudContextError ? ["cloud_connection_failed", "cloud_context_timeout"].includes(error.code) :
        error instanceof Error && /ECONN|ENET|EHOST|ENOTFOUND|timed out|offline|fetch failed/i.test(error.message);
    this.value = { ...this.value, status: denied ? "denied" : temporary ? "offline" : "error", is_admin: false,
      model_status: !denied && this.options.config.managedLlmState().credentials.length ? "cached" :
        error instanceof CloudHttpError && error.detail.code === "agent_upgrade_required" ? "upgrade_required" : "unavailable",
      last_error: error instanceof CloudHttpError ? error.message : contextDiagnostic(error instanceof Error ? error.message : String(error)) };
    this.logFailure(error);
  }

  private logFailure(error: unknown): void {
    this.options.logger.warn("native_cloud_access_failed", {
      http_status: error instanceof CloudHttpError || error instanceof CloudContextError ? error.httpStatus : undefined, error_code: error instanceof CloudHttpError ? error.detail.code : undefined,
      observed_error: error instanceof CloudHttpError ? error.detail.diagnostic : contextDiagnostic(error instanceof Error ? error.message : String(error)),
    });
  }

  async handoff(target: "admin" | "erp"): Promise<string> {
    const device = this.device;
    if (!device || this.value.status !== "connected" || (target === "admin" && !this.value.is_admin)) {
      throw new Error("请先连接公司 VPN 并验证设备权限");
    }
    const epoch = this.epoch;
    const controller = this.controller!;
    try {
      const result = await this.options.client.request(device.server_url, "/api/v1/device-access/browser-handoff", controller.signal, { target });
      if (epoch !== this.epoch || controller.signal.aborted) throw new Error("Native cloud request cancelled");
      this.assertDevice(result?.device, device);
      const pattern = target === "erp" ? /^lxe_erp_handoff_[A-Za-z0-9_-]{32,}$/u : /^lxe_handoff_[A-Za-z0-9_-]{32,}$/u;
      if (!pattern.test(result.code) || !Number.isFinite(result.expires_at)) throw new Error("Invalid browser handoff response");
      return `${device.server_url}/${target}?auth=identity-v1#handoff=${encodeURIComponent(result.code)}`;
    } catch (error) {
      if (epoch === this.epoch) {
        const code = error instanceof CloudHttpError ? error.detail.code : undefined;
        if (code && ["administrator_required", "administrator_revoked", "erp_device_access_denied"].includes(code)) {
          this.value.last_error = (error as Error).message;
          if (code.startsWith("administrator")) this.value.is_admin = false;
        } else await this.failed(error);
      }
      throw error;
    }
  }
}
