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
    };
    if (!config.cloud.device_id || !config.cloud.device_name || !config.cloud.vpn_ip
      || !config.cloud.data_server_url) {
      throw new Error("Cloud enrollment metadata is incomplete");
    }
    secrets.data_server_api_key = apiKey;
    secrets.erp_api_key = text(input.erpApiKey);
    secrets.cloud_permission_snapshot = null;
    this.repository.commit(config, secrets);
    return this.configuration();
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
}
