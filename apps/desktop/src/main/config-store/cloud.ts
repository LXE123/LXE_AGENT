import { text } from "./model";
import type {
  DesktopCloudConfiguration,
  DesktopCloudEnrollmentConfig,
} from "./public-types";
import type { DesktopConfigRepository } from "./repository";

export class DesktopCloudConfigService {
  constructor(private readonly repository: DesktopConfigRepository) {}

  configuration(): DesktopCloudConfiguration {
    const cloud = this.repository.readConfig().cloud;
    return {
      ...cloud,
      api_key_configured: Boolean(text(this.repository.readSecrets().data_server_api_key)),
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
      sync_interval_seconds: Math.max(30, Math.trunc(input.syncIntervalSeconds)),
      tunnel_name: text(input.tunnelName) || "lxe-agent",
    };
    if (!config.cloud.device_id || !config.cloud.device_name || !config.cloud.vpn_ip
      || !config.cloud.data_server_url) {
      throw new Error("Cloud enrollment metadata is incomplete");
    }
    secrets.data_server_api_key = apiKey;
    secrets.erp_api_key = text(input.erpApiKey);
    this.repository.commit(config, secrets);
    return this.configuration();
  }
}
