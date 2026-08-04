import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
import type {
  DesktopCloudActivationInput,
  DesktopCloudEnrollmentSelection,
  DesktopCloudPermissionSnapshot,
  DesktopCloudState,
  ManagedLlmCredential,
} from "@lxe/desktop-protocol";
import { DesktopCloudEnrollmentManager } from "./cloud-enrollment";
import type { DesktopConfigStore } from "./config-store";
import type { PreviewDataServerTarget } from "./data-server-policy";
import type { WireGuardProvisionerPort } from "./wireguard-provisioner";
import {
  parseServerDevicePermission,
  permissionSnapshotsEqual,
} from "./cloud-permissions";
import {
  parseManagedLlmCredential,
  parseManagedLlmStatus,
} from "./managed-llm";

export interface DesktopCloudClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(id: unknown): void;
}

const systemClock: DesktopCloudClock = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => {
    const timer = setInterval(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

interface DesktopCloudServiceOptions {
  dataRoot: string;
  supported: boolean;
  previewTarget?: PreviewDataServerTarget;
  config: DesktopConfigStore;
  enrollments: DesktopCloudEnrollmentManager;
  provisioner: WireGuardProvisionerPort;
  logger: Logger;
  now?: () => number;
  clock?: DesktopCloudClock;
  probeIntervalMs?: number;
  requestTimeoutMs?: number;
  onConfigured(): Promise<void>;
  onPermissionChanged?(allowedSkillTypes: readonly string[]): Promise<void> | void;
  onManagedLlmCredentialChanged?(credential: ManagedLlmCredential): Promise<void> | void;
  onStateChanged?(state: DesktopCloudState): void;
  fetch?: typeof globalThis.fetch;
}

interface CloudProbeTargetBase {
  dataServerUrl: string;
  apiToken: string;
}

interface PreviewCloudProbeTarget extends CloudProbeTargetBase {
  source: "preview";
}

interface ManagedCloudProbeTarget extends CloudProbeTargetBase {
  source: "managed";
  deviceId: string;
  deviceName: string;
  vpnIp: string;
}

type CloudProbeTarget = PreviewCloudProbeTarget | ManagedCloudProbeTarget;

interface CloudDeviceIdentity {
  deviceId: string;
  deviceName: string;
  vpnIp: string;
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export class DesktopCloudService {
  private connection: DesktopCloudState["connection"];
  private isAdmin = false;
  private lastError = "";
  private lastCheckedAt = 0;
  private permissionSnapshot: DesktopCloudPermissionSnapshot | null;
  private permissionFresh = false;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly clock: DesktopCloudClock;
  private readonly controllers = new Set<AbortController>();
  private activation: Promise<DesktopCloudState> | undefined;
  private probe: Promise<DesktopCloudState> | undefined;
  private probeTimer: unknown | undefined;
  private lastPublished = "";
  private stopped = false;

  constructor(private readonly options: DesktopCloudServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? systemClock;
    const configured = Boolean(options.previewTarget) || options.config.cloudConfiguration().managed;
    this.connection = configured ? "connecting" : options.supported ? "not_configured" : "unsupported";
    this.permissionSnapshot = options.previewTarget
      ? null
      : options.config.cloudPermissionSnapshot();
  }

  select(path: string): DesktopCloudEnrollmentSelection {
    if (!this.options.supported) throw new Error("公司云端仅支持 Windows 10/11 x64 安装包");
    return this.options.enrollments.select(path);
  }

  state(): DesktopCloudState {
    const permission = this.permissionState();
    if (this.options.previewTarget) {
      return {
        configured: true,
        is_admin: this.isAdmin,
        device_name: "",
        device_id: "",
        vpn_ip: "",
        connection: this.connection,
        last_error: this.lastError,
        last_checked_at: this.lastCheckedAt,
        ...permission,
      };
    }
    const cloud = this.options.config.cloudConfiguration();
    return {
      configured: cloud.managed && cloud.api_key_configured,
      is_admin: this.isAdmin,
      device_name: cloud.device_name,
      device_id: cloud.device_id,
      vpn_ip: cloud.vpn_ip,
      connection: this.connection,
      last_error: this.lastError,
      last_checked_at: this.lastCheckedAt,
      ...permission,
    };
  }

  allowedSkillTypes(): readonly string[] {
    return [...(this.permissionSnapshot?.allowed_skill_types ?? [])];
  }

  start(): Promise<DesktopCloudState> {
    this.stopped = false;
    if ((this.options.supported || this.options.previewTarget) && this.probeTimer === undefined) {
      this.probeTimer = this.clock.setInterval(() => {
        void this.check();
      }, Math.max(1, Math.trunc(this.options.probeIntervalMs ?? 60_000)));
    }
    return this.check();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.probeTimer !== undefined) this.clock.clearInterval(this.probeTimer);
    this.probeTimer = undefined;
    for (const controller of this.controllers) controller.abort(new Error("cloud service stopped"));
    const probe = this.probe;
    if (probe) await Promise.allSettled([probe]);
  }

  check(): Promise<DesktopCloudState> {
    return this.checkConnection(false);
  }

  retry(): Promise<DesktopCloudState> {
    return this.checkConnection(true);
  }

  activate(input: DesktopCloudActivationInput): Promise<DesktopCloudState> {
    if (this.activation) return this.activation;
    const previousProbe = this.probe;
    let tracked: Promise<DesktopCloudState>;
    tracked = Promise.resolve().then(async () => {
      if (previousProbe) await previousProbe.catch(() => undefined);
      return this.activateOnce(input);
    }).finally(() => {
      if (this.activation === tracked) this.activation = undefined;
    });
    this.activation = tracked;
    return tracked;
  }

  private checkConnection(showProgress: boolean): Promise<DesktopCloudState> {
    if (this.activation) return this.activation;
    if (this.probe) return this.probe;
    if (!this.options.supported && !this.options.previewTarget) {
      return Promise.resolve(this.setConnection("unsupported", ""));
    }
    const target = this.probeTarget();
    if (!target) {
      return Promise.resolve(this.setConnection("not_configured", ""));
    }
    if (showProgress) this.setConnection("connecting", "");
    const probeId = randomUUID();
    const logger = this.options.logger.child({
      probe_id: probeId,
      probe_kind: target.source === "preview" ? "admin" : "device",
      ...(target.source === "managed" && target.deviceId ? { device_id: target.deviceId } : {}),
      ...(target.source === "managed" && target.vpnIp ? { vpn_ip: target.vpnIp } : {}),
    });
    let tracked: Promise<DesktopCloudState>;
    tracked = this.probeStatus(target, logger).finally(() => {
      if (this.probe === tracked) this.probe = undefined;
    });
    this.probe = tracked;
    return tracked;
  }

  private async activateOnce(input: DesktopCloudActivationInput): Promise<DesktopCloudState> {
    if (!this.options.supported) throw new Error("公司云端仅支持 Windows 10/11 x64 安装包");
    const activationId = randomUUID();
    const startedAt = this.now();
    let logger = this.options.logger.child({ activation_id: activationId });
    let stage = "decrypt_enrollment";
    logger.info("cloud_enrollment_activation_started");
    this.setConnection("provisioning", "");
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
        tunnelName: "lxe-agent",
        apiKey: payload.data_server.api_token,
        ...(payload.erp ? { erpApiKey: payload.erp.api_token } : {}),
      });
      this.permissionSnapshot = null;
      this.permissionFresh = false;
      await this.options.onPermissionChanged?.([]);
      configured = true;
      this.options.enrollments.complete(input.enrollment_id);
      this.setConnection("connecting", "");
      stage = "activate_device";
      return await this.verifyActivation(
        {
          source: "managed",
          dataServerUrl: payload.data_server.url,
          apiToken: payload.data_server.api_token,
          deviceId: payload.device.id,
          deviceName: payload.device.name,
          vpnIp,
        },
        logger,
        { deviceId: payload.device.id, deviceName: payload.device.name, vpnIp },
      );
    } catch (error) {
      logger.error("cloud_device_activation_failed", {
        failed_stage: stage,
        duration_ms: Math.max(0, this.now() - startedAt),
        observed_error: this.diagnosticError(error),
      });
      this.setConnection("error", this.publicError(error));
      throw new Error(this.lastError);
    } finally {
      if (configured && !this.stopped) await this.options.onConfigured();
    }
  }

  private async probeStatus(
    target: CloudProbeTarget,
    logger: Logger,
  ): Promise<DesktopCloudState> {
    const startedAt = this.now();
    const statusPath = target.source === "preview" ? "admin/status" : "devices/status";
    let response: Response;
    try {
      response = await this.request(
        `${target.dataServerUrl.replace(/\/+$/u, "")}/api/v1/agent-data/${statusPath}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${target.apiToken}` },
          cache: "no-store",
        },
      );
    } catch (error) {
      logger.warn("cloud_status_check_failed", {
        duration_ms: Math.max(0, this.now() - startedAt),
        connection: "offline",
        observed_error: this.diagnosticError(error, target),
      });
      return this.setConnection(
        "offline",
        "公司网络暂不可用，Agent 将自动重试",
        true,
      );
    }
    if (!response.ok) {
      return this.httpFailure(response, "status", logger, startedAt, target);
    }
    const payload = objectValue(await response.json().catch(() => undefined));
    if (target.source === "preview") {
      if (!payload || payload.status !== "ok" || payload.role !== "admin") {
        return this.invalidCloudResponse(logger, startedAt, "invalid admin status response");
      }
      logger.info("cloud_status_check_completed", {
        duration_ms: Math.max(0, this.now() - startedAt),
        http_status: response.status,
        connection: "connected",
      });
      await this.acceptPreviewPermission();
      try {
        await this.syncManagedLlmCredential(payload.managed_llm, target, logger);
      } catch (error) {
        logger.warn("managed_llm_credential_refresh_failed", {
          observed_error: this.diagnosticError(error, target),
        });
      }
      return this.setConnection("connected", "", true, true);
    }
    if (!payload || payload.status !== "ok" || typeof payload.activation_required !== "boolean") {
      return this.invalidCloudResponse(logger, startedAt, "invalid device status response");
    }
    const identity = this.responseIdentity(payload);
    if (!identity) {
      return this.invalidCloudResponse(logger, startedAt, "invalid device identity response");
    }
    const expectedIdentity = {
      deviceId: target.deviceId,
      deviceName: target.deviceName,
      vpnIp: target.vpnIp,
    };
    if (!this.targetIdentityMatches(identity, expectedIdentity)) {
      return this.invalidCloudResponse(logger, startedAt, "device identity mismatch");
    }
    if (payload.activation_required) {
      logger.info("cloud_status_activation_required", {
        duration_ms: Math.max(0, this.now() - startedAt),
      });
      return this.verifyActivation(target, logger, identity);
    }
    const machineIdentity = resolveMachineIdentity(join(this.options.dataRoot, "db", "machine_identity.json"));
    if (String(payload.machine_id ?? "") !== machineIdentity.machine_id) {
      return this.invalidCloudResponse(logger, startedAt, "machine identity mismatch");
    }
    try {
      await this.acceptPermission(payload.permission, target.deviceId);
    } catch (error) {
      return this.invalidCloudResponse(
        logger,
        startedAt,
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await this.syncManagedLlmCredential(payload.managed_llm, target, logger);
    } catch (error) {
      logger.warn("managed_llm_credential_refresh_failed", {
        observed_error: this.diagnosticError(error, target),
      });
    }
    logger.info("cloud_status_check_completed", {
      duration_ms: Math.max(0, this.now() - startedAt),
      http_status: response.status,
      connection: "connected",
    });
    return this.setConnection("connected", "", true);
  }

  private async verifyActivation(
    target: ManagedCloudProbeTarget,
    logger: Logger,
    expectedIdentity: CloudDeviceIdentity,
  ): Promise<DesktopCloudState> {
    const startedAt = this.now();
    const identity = resolveMachineIdentity(join(this.options.dataRoot, "db", "machine_identity.json"));
    let response: Response;
    try {
      response = await this.request(
        `${target.dataServerUrl.replace(/\/+$/u, "")}/api/v1/agent-data/devices/activate`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${target.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ machine_id: identity.machine_id, hostname: hostname() }),
        },
      );
    } catch (error) {
      logger.warn("cloud_device_activation_failed", {
        failed_stage: "activate_device",
        duration_ms: Math.max(0, this.now() - startedAt),
        connection: "offline",
        observed_error: this.diagnosticError(error, target),
      });
      return this.setConnection(
        "offline",
        "公司网络暂不可用，Agent 将自动重试",
        true,
      );
    }
    if (!response.ok) {
      return this.httpFailure(response, "activation", logger, startedAt, target);
    }
    const payload = objectValue(await response.json().catch(() => undefined));
    const responseIdentity = payload ? this.responseIdentity(payload) : undefined;
    if (!payload || payload.status !== "ok" || !responseIdentity
      || !this.targetIdentityMatches(responseIdentity, expectedIdentity)
      || String(payload.machine_id ?? "") !== identity.machine_id) {
      return this.invalidCloudResponse(logger, startedAt, "activation identity mismatch");
    }
    try {
      await this.acceptPermission(payload.permission, target.deviceId);
    } catch (error) {
      return this.invalidCloudResponse(
        logger,
        startedAt,
        error instanceof Error ? error.message : String(error),
      );
    }
    logger.info("cloud_device_activation_completed", {
      duration_ms: Math.max(0, this.now() - startedAt),
      http_status: response.status,
      connection: "connected",
    });
    return this.setConnection("connected", "", true);
  }

  private probeTarget(): CloudProbeTarget | undefined {
    if (this.options.previewTarget) {
      return {
        source: "preview",
        dataServerUrl: this.options.previewTarget.dataServerUrl,
        apiToken: this.options.previewTarget.apiToken,
      };
    }
    const cloud = this.options.config.cloudConfiguration();
    if (!cloud.managed || !cloud.api_key_configured) return undefined;
    const apiToken = this.options.config.environment().LXE_DATA_SERVER_API_KEY ?? "";
    if (!apiToken) return undefined;
    return {
      source: "managed",
      dataServerUrl: cloud.data_server_url,
      apiToken,
      deviceId: cloud.device_id,
      deviceName: cloud.device_name,
      vpnIp: cloud.vpn_ip,
    };
  }

  private responseIdentity(payload: Record<string, unknown>): CloudDeviceIdentity | undefined {
    const deviceId = typeof payload.device_id === "string" ? payload.device_id.trim() : "";
    const deviceName = typeof payload.display_name === "string" ? payload.display_name.trim() : "";
    const vpnIp = typeof payload.wireguard_ip === "string" ? payload.wireguard_ip.trim() : "";
    return deviceId && deviceName && vpnIp ? { deviceId, deviceName, vpnIp } : undefined;
  }

  private targetIdentityMatches(
    left: CloudDeviceIdentity,
    right: CloudDeviceIdentity,
  ): boolean {
    return left.deviceId === right.deviceId
      && left.vpnIp === right.vpnIp;
  }

  private async httpFailure(
    response: Response,
    operation: "status" | "activation",
    logger: Logger,
    startedAt: number,
    target: CloudProbeTarget,
  ): Promise<DesktopCloudState> {
    const observedError = this.redactSensitiveText(
      await response.text().catch(() => ""),
      target,
    );
    const offline = response.status >= 500;
    const lastError = offline
      ? "公司云端暂时不可用"
      : operation === "status" && response.status === 404
        ? "公司云端版本不兼容，请联系管理员升级服务"
        : response.status === 409
          ? "该设备文件已绑定到另一台电脑"
          : response.status === 401 || response.status === 403
            ? target.source === "preview"
              ? "管理员凭证无效，请检查开发配置"
              : "设备凭证已失效，请联系管理员"
            : operation === "status"
              ? `公司云端状态检查失败（HTTP ${response.status}）`
              : `公司云端拒绝激活（HTTP ${response.status}）`;
    logger.warn(operation === "status" ? "cloud_status_check_failed" : "cloud_device_activation_failed", {
      ...(operation === "activation" ? { failed_stage: "activate_device" } : {}),
      duration_ms: Math.max(0, this.now() - startedAt),
      http_status: response.status,
      connection: offline ? "offline" : "error",
      ...(observedError ? { observed_error: observedError } : {}),
    });
    return this.setConnection(offline ? "offline" : "error", lastError, true);
  }

  private invalidCloudResponse(
    logger: Logger,
    startedAt: number,
    observedError: string,
  ): DesktopCloudState {
    logger.error("cloud_status_response_invalid", {
      duration_ms: Math.max(0, this.now() - startedAt),
      connection: "error",
      observed_error: observedError,
    });
    return this.setConnection(
      "error",
      observedError.includes("identity")
        ? "云端返回的设备身份不一致"
        : `公司云端权限响应无效：${observedError}`.slice(0, 300),
      true,
    );
  }

  private async acceptPermission(value: unknown, deviceId: string): Promise<void> {
    const next = parseServerDevicePermission(
      value,
      deviceId,
      Math.floor(this.now() / 1_000),
    );
    const previous = this.permissionSnapshot;
    if (previous?.device_id === deviceId) {
      if (next.permission_version < previous.permission_version) {
        throw new Error(
          `device permission version regressed from ${previous.permission_version} `
          + `to ${next.permission_version}`,
        );
      }
      if (next.permission_version === previous.permission_version
        && !permissionSnapshotsEqual(previous, next)) {
        throw new Error("device permission content changed without a version increase");
      }
      if (next.permission_version === previous.permission_version) {
        this.permissionFresh = true;
        return;
      }
    }
    this.options.config.saveCloudPermissionSnapshot(next);
    this.permissionSnapshot = next;
    this.permissionFresh = true;
    if (!previous
      || previous.allowed_skill_types.length !== next.allowed_skill_types.length
      || previous.allowed_skill_types.some((item) => !next.allowed_skill_types.includes(item))) {
      await this.options.onPermissionChanged?.([...next.allowed_skill_types]);
    }
  }

  private async acceptPreviewPermission(): Promise<void> {
    const previous = this.permissionSnapshot;
    this.permissionSnapshot = {
      device_id: "preview-admin",
      permission_profile: "full_access",
      permission_version: 0,
      allowed_skill_types: ["*"],
      verified_at: Math.floor(this.now() / 1_000),
    };
    this.permissionFresh = true;
    if (!previous?.allowed_skill_types.includes("*")) {
      await this.options.onPermissionChanged?.(["*"]);
    }
  }

  private async syncManagedLlmCredential(
    value: unknown,
    target: CloudProbeTarget,
    logger: Logger,
  ): Promise<void> {
    const status = parseManagedLlmStatus(value);
    if (!status) return;
    const cached = this.options.config.managedLlmCredential();
    if (cached?.credential_revision === status.credential_revision) return;
    const path = target.source === "preview"
      ? "admin/llm-credential"
      : "devices/llm-credential";
    const response = await this.request(
      `${target.dataServerUrl.replace(/\/+$/u, "")}/api/v1/agent-data/${path}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${target.apiToken}` },
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new Error(`managed LLM credential request failed (HTTP ${response.status})`);
    }
    const credential = parseManagedLlmCredential(
      await response.json().catch(() => undefined),
      status,
      this.now(),
    );
    this.options.config.saveManagedLlmCredential(credential);
    await this.options.onManagedLlmCredentialChanged?.(credential);
    logger.info("managed_llm_credential_refreshed", {
      provider: credential.provider,
      model: credential.model,
      credential_revision: credential.credential_revision,
    });
  }

  private permissionState(): Pick<
    DesktopCloudState,
    | "permission_status"
    | "permission_profile"
    | "permission_version"
    | "permission_verified_at"
  > {
    const snapshot = this.permissionSnapshot;
    return {
      permission_status: !snapshot
        ? "pending_verification"
        : this.permissionFresh
          ? snapshot.permission_profile === null ? "unassigned" : "verified"
          : "cached",
      permission_profile: snapshot?.permission_profile ?? null,
      permission_version: snapshot?.permission_version ?? 0,
      permission_verified_at: snapshot?.verified_at ?? 0,
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = this.clock.setTimeout(
      () => controller.abort(new Error("cloud request timed out")),
      Math.max(1, Math.trunc(this.options.requestTimeoutMs ?? 10_000)),
    );
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } finally {
      this.clock.clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  private setConnection(
    connection: DesktopCloudState["connection"],
    lastError: string,
    checked = false,
    isAdmin = false,
  ): DesktopCloudState {
    if (connection !== "connected") this.permissionFresh = false;
    this.connection = connection;
    this.isAdmin = isAdmin;
    this.lastError = lastError;
    if (checked) this.lastCheckedAt = Math.floor(this.now() / 1_000);
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (serialized !== this.lastPublished) {
      this.lastPublished = serialized;
      this.options.onStateChanged?.(state);
    }
    return state;
  }

  private diagnosticError(error: unknown, target?: CloudProbeTarget): string {
    const message = error instanceof Error ? error.message : String(error);
    return target ? this.redactSensitiveText(message, target) : message.trim().slice(0, 500);
  }

  private redactSensitiveText(value: string, target: CloudProbeTarget): string {
    let redacted = value.trim();
    for (const sensitive of [target.apiToken, target.dataServerUrl].filter(Boolean)) {
      redacted = redacted.replaceAll(sensitive, "[redacted]");
    }
    return redacted.slice(0, 500);
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
