import { text } from "./model";
import type {
  DesktopCloudConfiguration,
  DesktopCloudEnrollmentConfig,
  DesktopCloudPermissionSnapshot,
} from "./public-types";
import type { DesktopConfigRepository } from "./repository";
import { effectiveDesktopSecrets } from "./secrets";

export class DesktopCloudConfigService {
  constructor(
    private readonly repository: DesktopConfigRepository,
    private readonly secretEnvironment: Readonly<Record<string, string | undefined>> = {},
  ) {}

  configuration(): DesktopCloudConfiguration {
    const cloud = this.repository.readConfig().cloud;
    return {
      ...cloud,
      api_key_configured: Boolean(text(effectiveDesktopSecrets(
        this.repository.readSecrets(),
        this.secretEnvironment,
      ).data_server_api_key)),
    };
  }

  saveEnrollment(input: DesktopCloudEnrollmentConfig): DesktopCloudConfiguration {
    this.repository.requireSafeStorage();
    const apiKey = text(input.apiKey);
    if (!apiKey) throw new Error("Device upload token is required");
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
    secrets.erp_api_key = text(input.erpApiKey);
    secrets.cloud_permission_snapshot = null;
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
    secrets.erp_api_key = "";
    secrets.cloud_permission_snapshot = null;
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
    config: ReturnType<DesktopConfigRepository["readConfig"]>,
    secrets: ReturnType<DesktopConfigRepository["readSecrets"]>,
  ): void {
    secrets.managed_llm_credential = null;
    if (config.llm.credential_source === "cloud") {
      config.llm.provider = config.llm.last_local_provider;
      config.llm.credential_source = "local";
    }
  }
}
