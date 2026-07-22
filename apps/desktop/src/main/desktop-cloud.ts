import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
import type {
  DesktopCloudActivationInput,
  DesktopCloudEnrollmentSelection,
  DesktopCloudState,
} from "@lxe/desktop-protocol";
import { DesktopCloudEnrollmentManager } from "./cloud-enrollment";
import type { DesktopConfigStore } from "./config-store";
import type { WireGuardProvisionerPort } from "./wireguard-provisioner";

interface DesktopCloudServiceOptions {
  dataRoot: string;
  supported: boolean;
  config: DesktopConfigStore;
  enrollments: DesktopCloudEnrollmentManager;
  provisioner: WireGuardProvisionerPort;
  logger: Logger;
  now?: () => number;
  onConfigured(): Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export class DesktopCloudService {
  private connection: DesktopCloudState["connection"];
  private lastError = "";
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private activation: Promise<DesktopCloudState> | undefined;

  constructor(private readonly options: DesktopCloudServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    const configured = options.config.cloudConfiguration().managed;
    this.connection = configured ? "connecting" : options.supported ? "not_configured" : "unsupported";
  }

  select(path: string): DesktopCloudEnrollmentSelection {
    if (!this.options.supported) throw new Error("公司云端仅支持 Windows 10/11 x64 安装包");
    return this.options.enrollments.select(path);
  }

  state(): DesktopCloudState {
    const cloud = this.options.config.cloudConfiguration();
    return {
      configured: cloud.managed && cloud.api_key_configured,
      device_name: cloud.device_name,
      device_id: cloud.device_id,
      vpn_ip: cloud.vpn_ip,
      connection: this.connection,
      last_error: this.lastError,
    };
  }

  activate(input: DesktopCloudActivationInput): Promise<DesktopCloudState> {
    if (this.activation) return this.activation;
    this.activation = this.activateOnce(input).finally(() => { this.activation = undefined; });
    return this.activation;
  }

  async retry(): Promise<DesktopCloudState> {
    if (!this.options.supported) {
      this.connection = "unsupported";
      return this.state();
    }
    const cloud = this.options.config.cloudConfiguration();
    if (!cloud.managed || !cloud.api_key_configured) {
      this.connection = "not_configured";
      this.lastError = "";
      return this.state();
    }
    this.connection = "connecting";
    this.lastError = "";
    const environment = this.options.config.environment();
    const activationId = randomUUID();
    const logger = this.options.logger.child({
      activation_id: activationId,
      device_id: cloud.device_id,
      vpn_ip: cloud.vpn_ip,
    });
    return this.verifyActivation(
      environment.LXE_DATA_SERVER_API_KEY ?? "",
      cloud.data_server_url,
      logger,
    );
  }

  private async activateOnce(input: DesktopCloudActivationInput): Promise<DesktopCloudState> {
    if (!this.options.supported) throw new Error("公司云端仅支持 Windows 10/11 x64 安装包");
    const activationId = randomUUID();
    const startedAt = this.now();
    let logger = this.options.logger.child({ activation_id: activationId });
    let stage = "decrypt_enrollment";
    logger.info("cloud_enrollment_activation_started");
    this.connection = "provisioning";
    this.lastError = "";
    let configured = false;
    try {
      const payload = this.options.enrollments.decrypt(input.enrollment_id, input.password);
      const vpnIp = payload.wireguard.address.replace(/\/32$/u, "");
      logger = logger.child({ device_id: payload.device.id, vpn_ip: vpnIp });
      logger.info("cloud_enrollment_decrypted", {
        duration_ms: Math.max(0, this.now() - startedAt),
      });
      stage = "wireguard_provision";
      await this.options.provisioner.provision(payload, activationId);
      stage = "persist_configuration";
      this.options.config.saveCloudEnrollment({
        deviceId: payload.device.id,
        deviceName: payload.device.name,
        vpnIp,
        dataServerUrl: payload.data_server.url,
        syncIntervalSeconds: payload.data_server.sync_interval_seconds,
        tunnelName: "lxe-agent",
        apiKey: payload.data_server.api_token,
        ...(payload.erp ? { erpApiKey: payload.erp.api_token } : {}),
      });
      configured = true;
      this.options.enrollments.complete(input.enrollment_id);
      this.connection = "connecting";
      stage = "activate_device";
      await this.verifyActivation(payload.data_server.api_token, payload.data_server.url, logger);
      return this.state();
    } catch (error) {
      if (stage !== "activate_device") {
        logger.error("cloud_device_activation_failed", {
          failed_stage: stage,
          duration_ms: Math.max(0, this.now() - startedAt),
          observed_error: this.diagnosticError(error),
        });
      }
      this.connection = "error";
      this.lastError = this.publicError(error);
      throw new Error(this.lastError);
    } finally {
      if (configured) await this.options.onConfigured();
    }
  }

  private async verifyActivation(
    apiToken: string,
    dataServerUrl: string,
    logger: Logger,
  ): Promise<DesktopCloudState> {
    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const identity = resolveMachineIdentity(join(this.options.dataRoot, "db", "machine_identity.json"));
      const response = await this.fetch(`${dataServerUrl.replace(/\/+$/u, "")}/api/v1/agent-data/devices/activate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ machine_id: identity.machine_id, hostname: hostname() }),
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = await response.json() as Record<string, unknown>;
        const cloud = this.options.config.cloudConfiguration();
        if (String(payload.device_id ?? "") !== cloud.device_id
          || String(payload.wireguard_ip ?? "") !== cloud.vpn_ip
          || String(payload.machine_id ?? "") !== identity.machine_id) {
          const error = new Error("云端返回的设备身份不一致");
          logger.error("cloud_device_activation_failed", {
            failed_stage: "validate_device_identity",
            duration_ms: Math.max(0, this.now() - startedAt),
            http_status: response.status,
            observed_error: error.message,
          });
          throw error;
        }
        this.connection = "connected";
        this.lastError = "";
        logger.info("cloud_device_activation_completed", {
          duration_ms: Math.max(0, this.now() - startedAt),
          http_status: response.status,
          connection: this.connection,
        });
        return this.state();
      }
      if (response.status >= 500) {
        this.connection = "offline";
        this.lastError = "公司云端暂时不可用";
        logger.warn("cloud_device_activation_failed", {
          failed_stage: "activate_device",
          duration_ms: Math.max(0, this.now() - startedAt),
          http_status: response.status,
          connection: this.connection,
        });
        return this.state();
      }
      this.connection = "error";
      this.lastError = response.status === 409
        ? "该设备文件已绑定到另一台电脑"
        : response.status === 401 || response.status === 403
          ? "设备凭证已失效，请联系管理员"
          : `公司云端拒绝激活（HTTP ${response.status}）`;
      logger.warn("cloud_device_activation_failed", {
        failed_stage: "activate_device",
        duration_ms: Math.max(0, this.now() - startedAt),
        http_status: response.status,
        connection: this.connection,
      });
      return this.state();
    } catch (error) {
      if (error instanceof Error && error.message === "云端返回的设备身份不一致") throw error;
      this.connection = "offline";
      this.lastError = "公司网络暂不可用，Agent 将自动重试";
      logger.warn("cloud_device_activation_failed", {
        failed_stage: "activate_device",
        duration_ms: Math.max(0, this.now() - startedAt),
        connection: this.connection,
        observed_error: this.diagnosticError(error),
      });
      return this.state();
    } finally {
      clearTimeout(timeout);
    }
  }

  private diagnosticError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).trim().slice(0, 500);
  }

  private publicError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("设备文件") || message.includes("WireGuard")
      || message.includes("管理员授权") || message.includes("公司云端")) {
      return message.slice(0, 300);
    }
    return "公司云端配置未完成，请重试";
  }
}
