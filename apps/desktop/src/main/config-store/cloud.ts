import { text } from "./model";
import { randomBytes } from "node:crypto";
import type {
  DesktopCloudConfiguration,
  DesktopCloudEnrollmentConfig,
  DesktopCloudPermissionSnapshot,
} from "./public-types";
import type { DesktopConfigRepository } from "./repository";
import type { WireGuardTunnelConfiguration } from "../wireguard-types";

export class DesktopCloudConfigService {
  constructor(
    private readonly repository: DesktopConfigRepository,
    private readonly secretEnvironment: Readonly<Record<string, string | undefined>> = {},
  ) {}

  configuration(): DesktopCloudConfiguration {
    const cloud = this.repository.readConfig().cloud;
    return {
      ...cloud,
      api_key_configured: Boolean(this.identityCredential()),
    };
  }

  saveEnrollment(input: DesktopCloudEnrollmentConfig): DesktopCloudConfiguration {
    this.repository.requireSafeStorage();
    const apiKey = text(input.apiKey);
    if (!apiKey) throw new Error("Client identity credential is required");
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    config.cloud = {
      managed: true,
      device_id: text(input.deviceId),
      device_name: text(input.deviceName),
      vpn_ip: text(input.vpnIp),
      data_server_url: text(input.dataServerUrl).replace(/\/+$/u, ""),
      local_fallback_enabled: config.cloud.local_fallback_enabled,
      local_fallback_url: config.cloud.local_fallback_url,
      tunnel_name: text(input.tunnelName) || "lxe-agent",
      switch_in_progress: false,
    };
    if (!config.cloud.device_id || !config.cloud.device_name || !config.cloud.vpn_ip
      || !config.cloud.data_server_url) {
      throw new Error("Cloud enrollment metadata is incomplete");
    }
    secrets.data_server_api_key = apiKey;
    secrets.cloud_identity_candidate = "";
    secrets.cloud_business_token = "";
    secrets.cloud_business_erp_token = "";
    secrets.cloud_business_expires_at = 0;
    secrets.erp_api_key = text(input.erpApiKey);
    secrets.cloud_permission_snapshot = null;
    secrets.cloud_wireguard = input.wireGuard ? structuredClone(input.wireGuard) : null;
    this.clearManagedLlm(config, secrets);
    this.repository.commit(config, secrets);
    return this.configuration();
  }

  beginSwitch(): DesktopCloudConfiguration {
    this.repository.requireSafeStorage();
    const config = this.repository.readConfig();
    if (!config.cloud.managed) throw new Error("Cloud enrollment is not configured");
    if (!config.cloud.switch_in_progress) {
      config.cloud.switch_in_progress = true;
      this.repository.commit(config, this.repository.readSecrets());
    }
    return this.configuration();
  }

  abortSwitch(): DesktopCloudConfiguration {
    const config = this.repository.readConfig();
    if (config.cloud.switch_in_progress) {
      config.cloud.switch_in_progress = false;
      this.repository.commit(config, this.repository.readSecrets());
    }
    return this.configuration();
  }

  clearEnrollment(): DesktopCloudConfiguration {
    this.repository.requireSafeStorage();
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    config.cloud = {
      ...config.cloud,
      managed: false,
      device_id: "",
      device_name: "",
      vpn_ip: "",
      data_server_url: "",
      tunnel_name: "lxe-agent",
      switch_in_progress: false,
    };
    secrets.data_server_api_key = "";
    secrets.cloud_identity_candidate = "";
    secrets.cloud_business_token = "";
    secrets.cloud_business_erp_token = "";
    secrets.cloud_business_expires_at = 0;
    secrets.erp_api_key = "";
    secrets.cloud_permission_snapshot = null;
    secrets.cloud_wireguard = null;
    this.clearManagedLlm(config, secrets);
    this.repository.commit(config, secrets);
    return this.configuration();
  }

  recoverInterruptedSwitch(): boolean {
    if (!this.repository.readConfig().cloud.switch_in_progress) return false;
    this.clearEnrollment();
    return true;
  }

  permissionSnapshot(): DesktopCloudPermissionSnapshot | null {
    const config = this.repository.readConfig();
    const snapshot = this.repository.readSecrets().cloud_permission_snapshot;
    return snapshot?.device_id === config.cloud.device_id ? structuredClone(snapshot) : null;
  }

  identityCredential(): string {
    const token = this.repository.readSecrets().data_server_api_key;
    return /^lxe_(?:client|identity)_[A-Za-z0-9]+\.[A-Za-z0-9_-]+$/u.test(token) ? token : "";
  }

  legacyIdentityCredential(): string {
    const cloud = this.repository.readConfig().cloud;
    const token = this.repository.readSecrets().data_server_api_key;
    const match = /^lxe_dev_([A-Za-z0-9]{1,64})\.[A-Za-z0-9_-]{32,128}$/u.exec(token);
    return cloud.managed && !cloud.switch_in_progress && match?.[1] === cloud.device_id ? token : "";
  }

  migrationCandidate(legacyToken: string): string {
    this.repository.requireSafeStorage();
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    if (!legacyToken || this.legacyIdentityCredential() !== legacyToken) throw new Error("设备身份已变更，请重新检查公司云端");
    if (!secrets.cloud_identity_candidate) {
      secrets.cloud_identity_candidate = `lxe_client_${config.cloud.device_id}.${randomBytes(32).toString("base64url")}`;
      this.repository.commit(config, secrets); // Persist before any request can register this candidate.
    }
    const candidate = this.repository.readSecrets().cloud_identity_candidate;
    if (!candidate.startsWith(`lxe_client_${config.cloud.device_id}.`)
      || !/^lxe_client_[A-Za-z0-9]{1,64}\.[A-Za-z0-9_-]{43}$/u.test(candidate)) {
      throw new Error("待迁移身份存储无效，请联系管理员恢复身份");
    }
    return candidate;
  }

  completeIdentityMigration(legacyToken: string, candidate: string): void {
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    if (this.legacyIdentityCredential() !== legacyToken || secrets.cloud_identity_candidate !== candidate) {
      throw new Error("迁移期间设备身份已变更，请重新检查公司云端");
    }
    secrets.data_server_api_key = candidate;
    secrets.cloud_identity_candidate = "";
    secrets.cloud_business_token = "";
    secrets.cloud_business_erp_token = "";
    secrets.cloud_business_expires_at = 0;
    this.repository.commit(config, secrets);
  }

  businessCredential(): { token: string; erp_token: string; expires_at: number } {
    const secrets = this.repository.readSecrets();
    return { token: secrets.cloud_business_token, erp_token: secrets.cloud_business_erp_token,
      expires_at: secrets.cloud_business_expires_at };
  }

  saveBusinessCredential(value: { token: string; erp_token: string; expires_at: number }): void {
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    secrets.cloud_business_token = value.token;
    secrets.cloud_business_erp_token = value.erp_token;
    secrets.cloud_business_expires_at = value.expires_at;
    this.repository.commit(config, secrets);
  }

  wireGuardConfiguration(): WireGuardTunnelConfiguration | null {
    return structuredClone(this.repository.readSecrets().cloud_wireguard);
  }

  savePermissionSnapshot(
    snapshot: DesktopCloudPermissionSnapshot,
  ): DesktopCloudPermissionSnapshot {
    this.repository.requireSafeStorage();
    const config = this.repository.readConfig();
    if (!config.cloud.managed || snapshot.device_id !== config.cloud.device_id) {
      throw new Error("Device permission snapshot does not match cloud enrollment");
    }
    const secrets = this.repository.readSecrets();
    secrets.cloud_permission_snapshot = structuredClone(snapshot);
    this.repository.commit(config, secrets);
    return structuredClone(snapshot);
  }

  private clearManagedLlm(
    _config: ReturnType<DesktopConfigRepository["readConfig"]>,
    secrets: ReturnType<DesktopConfigRepository["readSecrets"]>,
  ): void {
    secrets.managed_llm_credential = null;
    secrets.managed_llm_state = { revision: 0, default_target: null, models: [], credentials: [] };
  }
}
