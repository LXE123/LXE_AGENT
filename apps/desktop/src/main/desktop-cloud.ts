import { type TelemetryTarget } from "@lxe/core";
import { NativeCloudAccess, NativeIdentityChanged } from "./native-cloud-access";
import { DirectNativeCloudClient, type NativeCloudClient } from "./native-cloud-client";
import { companyServerUrl } from "./company-server";
import type { DesktopObservedDevice } from "@lxe/desktop-protocol";
import { CloudHttpError, cloudErrorMessage, limitCloudText, parseCloudError } from "./cloud-errors";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
import type {
  DesktopCloudActivationInput,
  DesktopCloudDependencyState,
  DesktopCloudEnrollmentSelection,
  DesktopCloudPermissionSnapshot,
  DesktopCloudState,
  ManagedLlmCredential,
} from "@lxe/desktop-protocol";
import { DesktopCloudEnrollmentManager } from "./cloud-enrollment";
import type { DesktopConfigStore } from "./config-store";
import {
  previousEnrollmentRemoved,
  type WireGuardDependencyStatus,
  type WireGuardProvisionerPort,
} from "./wireguard-provisioner";
import { wireGuardTunnelFromEnrollment } from "./wireguard-types";
import {
  legacySnapshotCanUpgrade,
  parseDeviceContext,
  sameObservedDevice,
  permissionSnapshotsEqual,
} from "./cloud-permissions";
import { CloudContextError, contextDiagnostic, type CloudContextQuery } from "./cloud-context";

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
  contextClient?: CloudContextQuery;
  accessClient?: NativeCloudClient;
  dataRoot: string;
  llmConfigRoot?: string;
  supported: boolean;
  unsupportedMessage?: string;
  config: DesktopConfigStore;
  enrollments: DesktopCloudEnrollmentManager;
  provisioner: WireGuardProvisionerPort;
  logger: Logger;
  now?: () => number;
  clock?: DesktopCloudClock;
  probeIntervalMs?: number;
  requestTimeoutMs?: number;
  onConfigured(): Promise<void>;
  onTelemetryTargetChanged?(target: TelemetryTarget): Promise<void> | void;
  onPermissionChanged?(allowedSkillTypes: readonly string[]): Promise<void> | void;
  onManagedLlmCredentialChanged?(credential: ManagedLlmCredential | null): Promise<void> | void;
  onStateChanged?(state: DesktopCloudState): void;
  fetch?: typeof globalThis.fetch;
}

interface CloudProbeTargetBase {
  dataServerUrl: string;
  apiToken: string;
}

interface ManagedCloudProbeTarget extends CloudProbeTargetBase {
  source: "managed";
  deviceId: string;
  deviceName: string;
  vpnIp: string;
}

type CloudProbeTarget = ManagedCloudProbeTarget;

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
  private readonly native: NativeCloudAccess;
  private connection: DesktopCloudState["connection"];
  private isAdmin = false;
  private lastError = "";
  private lastCheckedAt = 0;
  private permissionSnapshot: DesktopCloudPermissionSnapshot | null;
  private permissionFresh = false;
  private pendingDevice: DesktopObservedDevice | null = null;
  private confirmation: Promise<DesktopCloudState> | undefined;
  private permissionError = "";
  private permissionFailure: "denied" | "error" | undefined;
  private contextController: AbortController | undefined;
  private contextGeneration = 0;
  private round: Promise<DesktopCloudState> | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly clock: DesktopCloudClock;
  private readonly controllers = new Set<AbortController>();
  private activation: Promise<DesktopCloudState> | undefined;
  private dependencyPreparation: Promise<DesktopCloudState> | undefined;
  private reconnection: Promise<DesktopCloudState> | undefined;
  private probe: Promise<DesktopCloudState> | undefined;
  private probeTimer: unknown | undefined;
  private lastPublished = "";
  private stopped = false;
  private recoveredInterruptedSwitch: boolean;
  private dependencyState: DesktopCloudDependencyState;
  private dependencyError = "";

  constructor(private readonly options: DesktopCloudServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? systemClock;
    const dependency = options.provisioner.dependencyStatus?.() ?? { state: "not_required" as const, error: "" };
    this.dependencyState = dependency.state;
    this.dependencyError = dependency.error;
    this.recoveredInterruptedSwitch = options.config.recoverInterruptedCloudEnrollmentSwitch();
    const configured = options.config.cloudConfiguration().managed;
    this.connection = this.recoveredInterruptedSwitch
      ? "error"
      : configured ? "connecting" : options.supported ? "not_configured" : "unsupported";
    if (this.recoveredInterruptedSwitch) {
      this.lastError = "上次 Enrollment 切换中断，旧绑定已清除，请重新导入或重试新 Enrollment";
      options.logger.warn("cloud_enrollment_interrupted_switch_cleared", {
        previous_removed: true,
      });
    }
    this.permissionSnapshot = options.config.cloudPermissionSnapshot();
    this.native = new NativeCloudAccess({ config: options.config,
      client: options.accessClient ?? new DirectNativeCloudClient(), logger: options.logger,
      llmConfigRoot: options.llmConfigRoot ?? join(process.cwd(), "config", "llm"),
      now: this.now, changed: value => options.onManagedLlmCredentialChanged?.(value) });

  }

  select(path: string): DesktopCloudEnrollmentSelection {
    if (!this.options.supported) throw new Error(this.unsupportedMessage());
    return this.options.enrollments.select(path);
  }

  state(): DesktopCloudState {
    const permission = this.permissionState();
    const cloud = this.options.config.cloudConfiguration();
    const switching = cloud.switch_in_progress;
    return {
      native_access: this.native.state(),
      configured: cloud.managed && !switching,
      is_admin: this.isAdmin,
      device_name: switching ? "" : cloud.device_name,
      device_id: switching ? "" : cloud.device_id,
      vpn_ip: switching ? "" : cloud.vpn_ip,
      connection: this.connection,
      last_error: this.lastError,
      last_checked_at: this.lastCheckedAt,
      dependency_state: this.dependencyState,
      dependency_error: this.dependencyError,
      ...permission,
      permission_error: this.permissionError,
      device_context: {
        server_url: companyServerUrl(cloud),
        device: switching ? null : this.options.config.cloudObservedDevice(),
        pending_device: switching ? null : this.pendingDevice,
        skill_types: switching ? [] : [...this.allowedSkillTypes()],
        server_capabilities: switching ? null : this.permissionSnapshot?.server_capabilities ?? null,
        erp_actions: switching ? null : this.permissionSnapshot?.erp_actions ?? null,
      },
    };
  }

  allowedSkillTypes(): readonly string[] {
    return [...(this.permissionSnapshot?.allowed_skill_types ?? [])];
  }

  async erpDashboardUrl(): Promise<string> {
    if (!this.state().desktop_features.some(name => name === "erp_dashboard" || name === "*")) {
      throw new Error("当前设备没有 FBA ERP 访问权限");
    }
    return this.adminDashboardUrl("erp");
  }

  async adminDashboardUrl(destination: "admin" | "erp" = "admin"): Promise<string> {
    try { return await this.native.handoff(destination); }
    finally { this.publishState(); }
  }

  private validatePrincipal(payload: Record<string, unknown>, target: ManagedCloudProbeTarget): void {
    const kind = target.apiToken.startsWith("lxe_identity_") ? "system_administrator" : "managed_device";
    if (payload.principal_kind !== kind || payload.principal_id !== target.deviceId
      || payload.registration_status !== "active"
      || (payload.management_role !== "member" && payload.management_role !== "administrator")
      || !Number.isSafeInteger(payload.management_version) || Number(payload.management_version) < 1) {
      throw new Error("Invalid server principal identity or management role");
    }
  }

  start(): Promise<DesktopCloudState> {
    this.stopped = false;
    if (this.probeTimer === undefined) {
      this.probeTimer = this.clock.setInterval(() => {
        void this.check();
      }, Math.max(1, Math.trunc(this.options.probeIntervalMs ?? 60_000)));
    }
    if (this.recoveredInterruptedSwitch) {
      this.recoveredInterruptedSwitch = false;
      return Promise.resolve(this.setConnection("error", this.lastError));
    }
    return this.check();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.options.onTelemetryTargetChanged?.({enabled: false});
    this.cancelContext();
    if (this.probeTimer !== undefined) this.clock.clearInterval(this.probeTimer);
    this.probeTimer = undefined;
    for (const controller of this.controllers) controller.abort(new Error("cloud service stopped"));
    const probe = this.probe;
    await Promise.allSettled([probe, this.round, this.confirmation].filter(Boolean));
  }

  async clearModelCache(): Promise<DesktopCloudState> {
    this.cancelContext();
    await this.native.clear();
    return this.publishState();
  }

  check(): Promise<DesktopCloudState> {
    return this.checkConnection(false);
  }

  retry(): Promise<DesktopCloudState> {
    if (!this.options.provisioner.reconnect) return this.checkConnection(true);
    if (this.reconnection) return this.reconnection;
    let tracked: Promise<DesktopCloudState>;
    tracked = this.reconnectOnce().finally(() => {
      if (this.reconnection === tracked) this.reconnection = undefined;
    });
    this.reconnection = tracked;
    return tracked;
  }

  prepareDependencies(): Promise<DesktopCloudState> {
    if (!this.options.provisioner.prepareDependencies) return Promise.resolve(this.state());
    if (this.dependencyPreparation) return this.dependencyPreparation;
    let tracked: Promise<DesktopCloudState>;
    tracked = this.options.provisioner.prepareDependencies((status) => {
      this.setDependencyStatus(status);
    }).then((status) => {
      this.setDependencyStatus(status);
      return this.state();
    }).finally(() => {
      if (this.dependencyPreparation === tracked) this.dependencyPreparation = undefined;
    });
    this.dependencyPreparation = tracked;
    return tracked;
  }

  activate(input: DesktopCloudActivationInput): Promise<DesktopCloudState> {
    if (this.activation) return this.activation;
    this.cancelContext();
    this.pendingDevice = null;
    const previousProbe = this.confirmation ?? this.round ?? this.probe;
    let tracked: Promise<DesktopCloudState>;
    tracked = Promise.resolve().then(async () => {
      await this.options.onTelemetryTargetChanged?.({enabled: false});
      if (previousProbe) await previousProbe.catch(() => undefined);
      await this.activateOnce(input);
      return this.state();
    }).finally(() => {
      if (this.activation === tracked) this.activation = undefined;
    });
    this.activation = tracked;
    return tracked;
  }

  private cancelContext(): void {
    this.native.cancel();
    this.contextGeneration += 1;
    this.contextController?.abort();
    this.contextController = undefined;
  }

  private checkConnection(showProgress: boolean): Promise<DesktopCloudState> {
    if (this.activation) return this.activation;
    if (this.confirmation) return this.confirmation;
    if (this.round) return this.round;
    const tracked = Promise.allSettled([this.checkIdentityConnection(showProgress), this.syncSkillPermission()])
      .then(() => this.state()).finally(() => { if (this.round === tracked) this.round = undefined; });
    this.round = tracked;
    return tracked;
  }

  confirmDevice(): Promise<DesktopCloudState> {
    if (this.confirmation) return this.confirmation;
    if (this.activation || this.options.config.cloudConfiguration().managed || !this.pendingDevice) return Promise.resolve(this.state());
    const expected = { ...this.pendingDevice };
    this.cancelContext();
    const previous = this.round;
    const work = Promise.resolve().then(async () => {
      if (previous) await previous;
      if (!this.stopped && !this.activation && !this.options.config.cloudConfiguration().managed) await this.syncSkillPermission(expected);
      return this.state();
    }).finally(() => { if (this.confirmation === work) this.confirmation = undefined; });
    this.confirmation = work;
    return work;
  }

  private async syncSkillPermission(confirmedDevice?: DesktopObservedDevice): Promise<void> {
    const cloud = this.options.config.cloudConfiguration();
    const serverUrl = companyServerUrl(cloud);
    if (this.stopped || !serverUrl || cloud.switch_in_progress) {
      await this.options.onTelemetryTargetChanged?.({enabled: false});
      return;
    }
    this.cancelContext();
    const generation = this.contextGeneration;
    const controller = new AbortController();
    this.contextController = controller;
    const current = () => {
      const latest = this.options.config.cloudConfiguration();
      return !this.stopped && generation === this.contextGeneration && !latest.switch_in_progress
        && latest.managed === cloud.managed && latest.device_id === cloud.device_id && latest.vpn_ip === cloud.vpn_ip
        && latest.data_server_url === cloud.data_server_url;
    };
    try {
      if (!this.options.contextClient) throw new CloudContextError("Device permission CLI is not configured", "cloud_context_unavailable");
      const value = await this.options.contextClient.query(serverUrl, controller.signal);
      if (!current()) return;
      const next = parseDeviceContext(value, cloud.managed ? cloud.device_id : undefined, cloud.managed ? cloud.vpn_ip : undefined, Math.floor(this.now() / 1_000));
      const observed = { ...next.observed_device!, server_url: serverUrl };
      next.observed_device = observed;
      const previousDevice = this.options.config.cloudObservedDevice();
      if (!cloud.managed && (this.pendingDevice || (previousDevice && !sameObservedDevice(previousDevice, observed)))) {
        if (!confirmedDevice || !sameObservedDevice(confirmedDevice, observed)) {
          this.pendingDevice = observed;
          throw new Error("Device context identity mismatch");
        }
      }
      await this.acceptPermission(next);
      this.pendingDevice = null;
      if (!current()) return;
      this.permissionError = "";
      this.permissionFailure = undefined;
      await this.options.onTelemetryTargetChanged?.({enabled: true, server_url: serverUrl,
        device: {kind: observed.kind, id: observed.id}});
      if (!current()) return;
      await this.native.sync(observed);
      if (!current()) return;
    } catch (error) {
      if (!current()) return;
      await this.native.failed(error instanceof Error && error.message === "Device context identity mismatch"
        ? new NativeIdentityChanged(error.message) : error);
      if (!current()) return;
      this.permissionFresh = false;
      this.permissionError = contextDiagnostic(error instanceof Error ? error.message : String(error));
      const denied = (error instanceof CloudContextError && [401, 403].includes(error.httpStatus ?? 0))
        || (error instanceof Error && error.message === "Device context identity mismatch")
        || error instanceof NativeIdentityChanged;
      const temporary = error instanceof CloudContextError && (
        error.code === "cloud_connection_failed" || error.code === "cloud_context_timeout"
        || (error.httpStatus !== undefined && error.httpStatus >= 500));
      if (denied || !temporary) await this.options.onTelemetryTargetChanged?.({enabled: false});
      this.permissionFailure = denied ? "denied" : temporary ? undefined : "error";
      if (denied) {
        this.permissionSnapshot = null;
        this.options.config.clearCloudPermissionSnapshot();
        await this.options.onPermissionChanged?.([]);
      }
      this.options.logger.warn("cloud_skill_permission_failed", { observed_error: this.permissionError });
    } finally {
      if (current()) {
        this.contextController = undefined;
        this.publishState();
      }
    }
  }

  private checkIdentityConnection(showProgress: boolean): Promise<DesktopCloudState> {
    if (this.activation) return this.activation;
    if (this.probe) return this.probe;
    const legacy = this.options.config.cloudLegacyIdentityCredential();
    if (legacy) {
      // Defer execution until this.probe is assigned, including synchronous status callbacks.
      let tracked: Promise<DesktopCloudState>;
      tracked = Promise.resolve().then(() => this.migrateIdentity(legacy)).finally(() => {
        if (this.probe === tracked) this.probe = undefined;
      });
      this.probe = tracked;
      return tracked;
    }
    if (!this.options.supported && !this.options.config.cloudConfiguration().managed) {
      return Promise.resolve(this.setConnection("unsupported", ""));
    }
    const target = this.probeTarget();
    if (!target) {
      if (this.options.config.cloudConfiguration().managed) {
        return Promise.resolve(this.setConnection("error", "设备身份凭据缺失或格式不受支持，请联系管理员恢复身份"));
      }
      return Promise.resolve(this.setConnection("not_configured", ""));
    }
    if (showProgress) this.setConnection("connecting", "");
    const probeId = randomUUID();
    const logger = this.options.logger.child({
      probe_id: probeId,
      probe_kind: "identity",
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

  private async migrateIdentity(legacy: string): Promise<DesktopCloudState> {
    this.setConnection("migrating", "");
    try {
      const cloud = this.options.config.cloudConfiguration();
      const candidate = this.options.config.cloudMigrationCandidate(legacy);
      const machine = resolveMachineIdentity(join(this.options.dataRoot, "db", "machine_identity.json"));
      const base = `${cloud.data_server_url.replace(/\/+$/u, "")}/api/v1/agent-data/identity/migration`;
      const post = (action: string, token: string, extra: Record<string, string> = {}) => this.request(`${base}/${action}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ machine_id: machine.machine_id, ...extra }), cache: "no-store",
      });
      const result = async (response: Response): Promise<string> => {
        if (!response.ok) {
          const prefix = response.status === 404 ? "公司云端尚未支持自动身份迁移" : "设备身份迁移失败";
          const parsed = parseCloudError(await response.text().catch(() => ""), [legacy, candidate, cloud.data_server_url]);
          throw new CloudHttpError(parsed, response.status, `${prefix}（HTTP ${response.status}）：${parsed.diagnostic}`);
        }
        const body = objectValue(await response.json());
        if (!body || body.device_id !== cloud.device_id || body.machine_id !== machine.machine_id
          || !["pending", "prepared", "completed", "error"].includes(String(body.state))) {
          throw new Error("身份迁移响应与当前设备不一致");
        }
        if (body.state === "error") throw new Error(`设备身份迁移异常：${String(body.error_code)}`);
        return String(body.state);
      };
      // A persisted candidate may already be active when the last confirmation response was lost.
      const status = await post("status", candidate);
      let state = status.status === 401
        ? await result(await post("prepare", legacy, { candidate_token: candidate }))
        : await result(status);
      if (state === "prepared") state = await result(await post("confirm", candidate));
      if (state !== "completed") throw new Error("身份迁移尚未完成，将自动重试");
      this.options.config.completeCloudIdentityMigration(legacy, candidate);
      this.options.logger.info("cloud_identity_migration_completed", { device_id: cloud.device_id });
      const target = this.probeTarget();
      if (!target) throw new Error("迁移后的设备身份未能读取");
      return await this.probeStatus(target, this.options.logger);
    } catch (error) {
      const message = error instanceof CloudHttpError ? error.message : this.diagnosticError(error);
      this.options.logger.warn("cloud_identity_migration_failed", {
        observed_error: error instanceof CloudHttpError ? error.detail.diagnostic : message,
        ...(error instanceof CloudHttpError ? { http_status: error.httpStatus, error_code: error.detail.code } : {}),
      });
      return this.setConnection("error", limitCloudText(`身份迁移未完成，将自动重试。${message}`, 300), true);
    }
  }

  private async activateOnce(input: DesktopCloudActivationInput): Promise<DesktopCloudState> {
    if (!this.options.supported) throw new Error(this.unsupportedMessage());
    const activationId = randomUUID();
    const startedAt = this.now();
    let logger = this.options.logger.child({ activation_id: activationId });
    let stage = "decrypt_enrollment";
    logger.info("cloud_enrollment_activation_started");
    this.setConnection("provisioning", "");
    let configured = false;
    let switchStarted = false;
    let previousRemoved = false;
    const previousPermission = this.permissionSnapshot;
    const previousManagedLlmCredential = this.options.config.managedLlmCredential();
    try {
      const payload = this.options.enrollments.decrypt(input.enrollment_id, input.password);
      if (payload.existing_tunnel) {
        const state = await this.activateExistingEnrollment(payload);
        this.options.enrollments.complete(input.enrollment_id);
        configured = true;
        return state;
      }
      if (payload.enrollment_version !== 5) throw new Error("此设备文件使用旧版业务凭据，请在管理后台换发接入凭据后导入");
      const vpnIp = payload.wireguard.address.replace(/\/32$/u, "");
      logger = logger.child({ device_id: payload.device.id, vpn_ip: vpnIp });
      logger.info("cloud_enrollment_decrypted", {
        duration_ms: Math.max(0, this.now() - startedAt),
      });
      const dependency = this.options.provisioner.dependencyStatus?.();
      if (dependency && dependency.state !== "ready" && dependency.state !== "not_required") {
        this.setDependencyStatus(dependency);
        throw new Error("请先安装 Homebrew 和 wireguard-tools");
      }
      const previousWireGuard = this.options.config.cloudWireGuardConfiguration();
      if (this.options.config.cloudConfiguration().managed) {
        stage = "begin_destructive_switch";
        this.options.config.beginCloudEnrollmentSwitch();
        switchStarted = true;
        this.permissionSnapshot = null;
        this.permissionFresh = false;
        this.setConnection("provisioning", "");
        await this.options.onPermissionChanged?.([]);
        await this.options.onManagedLlmCredentialChanged?.(null);
        await this.options.onConfigured();
      }
      stage = "wireguard_provision";
      await this.options.provisioner.provision(payload, activationId, previousWireGuard);
      if (switchStarted) previousRemoved = true;
      stage = "persist_configuration";
      this.options.config.saveCloudEnrollment({
        deviceId: payload.device.id,
        deviceName: payload.device.name,
        vpnIp,
        dataServerUrl: payload.data_server.url,
        tunnelName: "lxe-agent",
        apiKey: payload.data_server.api_token,
        wireGuard: wireGuardTunnelFromEnrollment(payload),
      });
      const wasDestructiveSwitch = switchStarted;
      switchStarted = false;
      configured = true;
      this.permissionSnapshot = null;
      this.permissionFresh = false;
      if (!wasDestructiveSwitch) await this.options.onPermissionChanged?.([]);
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
      previousRemoved ||= switchStarted && previousEnrollmentRemoved(error);
      if (switchStarted) {
        try {
          if (previousRemoved) {
            this.options.config.clearCloudEnrollment();
            this.permissionSnapshot = null;
            this.permissionFresh = false;
          } else {
            this.options.config.abortCloudEnrollmentSwitch();
            this.permissionSnapshot = previousPermission;
            this.permissionFresh = false;
            await this.options.onPermissionChanged?.(
              previousPermission?.allowed_skill_types ?? [],
            );
            await this.options.onManagedLlmCredentialChanged?.(previousManagedLlmCredential);
          }
          await this.options.onConfigured();
        } catch (recoveryError) {
          logger.error("cloud_enrollment_switch_recovery_failed", {
            previous_removed: previousRemoved,
            observed_error: this.diagnosticError(recoveryError),
          });
        }
      }
      logger.error("cloud_device_activation_failed", {
        failed_stage: stage,
        previous_removed: previousRemoved,
        duration_ms: Math.max(0, this.now() - startedAt),
        observed_error: this.diagnosticError(error),
      });
      const publicError = this.publicError(error);
      this.setConnection(
        "error",
        previousRemoved ? `旧绑定已移除；${publicError}`.slice(0, 300) : publicError,
      );
      throw new Error(this.lastError);
    } finally {
      if (configured && !this.stopped) {
        await this.syncSkillPermission();
        await this.options.onConfigured();
      }
    }
  }

  private async activateExistingEnrollment(payload: import("./cloud-enrollment").ExistingCloudEnrollmentPayload): Promise<DesktopCloudState> {
    const target: ManagedCloudProbeTarget = { source: "managed", dataServerUrl: payload.data_server.url,
      apiToken: payload.data_server.api_token, deviceId: payload.device.id, deviceName: payload.device.name,
      vpnIp: payload.wireguard.address.replace(/\/32$/u, "") };
    const machine = resolveMachineIdentity(join(this.options.dataRoot, "db", "machine_identity.json"));
    const response = await this.request(`${target.dataServerUrl}/api/v1/agent-data/identity/activate`, {
      method: "POST", headers: { authorization: `Bearer ${target.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ machine_id: machine.machine_id, hostname: hostname() }),
    });
    if (!response.ok) throw new Error(this.diagnosticError(new Error(`Identity activation HTTP ${response.status}: ${await response.text()}`), target));
    const result = objectValue(await response.json());
    if (!result) throw new Error("Invalid identity activation response");
    this.validatePrincipal(result, target);
    if (result.machine_id !== machine.machine_id || result.wireguard_ip !== target.vpnIp) throw new Error("Identity binding mismatch");
    const previous = this.options.config.cloudConfiguration();
    const tunnel = previous.vpn_ip === target.vpnIp ? this.options.config.cloudWireGuardConfiguration() : null;
    this.options.config.saveCloudEnrollment({ deviceId: target.deviceId, deviceName: String(result.display_name),
      vpnIp: target.vpnIp, dataServerUrl: target.dataServerUrl, apiKey: target.apiToken,
      tunnelName: tunnel?.tunnel_name ?? "", ...(tunnel ? { wireGuard: tunnel } : {}) });
    this.permissionSnapshot = null;
    return this.setConnection("connected", "", true, result.management_role === "administrator");
  }

  private async probeStatus(
    target: CloudProbeTarget,
    logger: Logger,
  ): Promise<DesktopCloudState> {
    const startedAt = this.now();
    const statusPath = "identity";
    let response: Response;
    try {
      response = await this.request(
        `${target.dataServerUrl.replace(/\/+$/u, "")}/api/v1/agent-data/${statusPath}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${target.apiToken}`,
            "x-lxe-permission-contract": "2",
          },
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
      this.validatePrincipal(payload, target);
    } catch (error) {
      return this.invalidCloudResponse(
        logger,
        startedAt,
        error instanceof Error ? error.message : String(error),
      );
    }
    logger.info("cloud_status_check_completed", {
      duration_ms: Math.max(0, this.now() - startedAt),
      http_status: response.status,
      connection: "connected",
    });
    return this.setConnection("connected", "", true, payload.management_role === "administrator");
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
        `${target.dataServerUrl.replace(/\/+$/u, "")}/api/v1/agent-data/identity/activate`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${target.apiToken}`,
            "content-type": "application/json",
            "x-lxe-permission-contract": "2",
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
      this.validatePrincipal(payload, target);
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
    return this.setConnection("connected", "", true, payload.management_role === "administrator");
  }

  private probeTarget(): CloudProbeTarget | undefined {
    const cloud = this.options.config.cloudConfiguration();
    if (!cloud.managed || cloud.switch_in_progress || !cloud.api_key_configured) return undefined;
    const apiToken = this.options.config.cloudIdentityCredential();
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
    const parsed = parseCloudError(await response.text().catch(() => ""), [target.apiToken, target.dataServerUrl]);
    const observedError = parsed.diagnostic;
    const offline = response.status >= 500;
    const fallback = offline
      ? "公司云端暂时不可用"
      : operation === "status" && response.status === 404
        ? "公司云端版本不兼容，请联系管理员升级服务"
        : response.status === 409
          ? "该设备文件已绑定到另一台电脑"
          : response.status === 401 || response.status === 403
            ? "设备凭证已失效，请联系管理员"
            : operation === "status"
              ? `公司云端状态检查失败（HTTP ${response.status}）`
              : `公司云端拒绝激活（HTTP ${response.status}）`;
    const lastError = cloudErrorMessage(parsed, response.status, fallback);
    logger.warn(operation === "status" ? "cloud_status_check_failed" : "cloud_device_activation_failed", {
      ...(operation === "activation" ? { failed_stage: "activate_device" } : {}),
      ...(parsed.code ? { error_code: parsed.code } : {}),
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

  private async acceptPermission(next: DesktopCloudPermissionSnapshot): Promise<void> {
    const deviceId = next.device_id;
    const previous = this.permissionSnapshot;
    if (previous?.device_id === deviceId) {
      if (next.permission_version < previous.permission_version) {
        throw new Error(
          `device permission version regressed from ${previous.permission_version} `
          + `to ${next.permission_version}`,
        );
      }
      if (next.permission_version === previous.permission_version) {
        if (previous.permission_schema === 2 && next.permission_schema === 1) {
          throw new Error("device permission contract regressed from v2 to v1");
        }
        if (legacySnapshotCanUpgrade(previous, next)) {
          // A verified v2 response replaces the frozen v1 compatibility snapshot.
        } else if (next.permission_profile !== previous.permission_profile) {
          throw new Error("device permission profile changed without an assignment version increase");
        } else if (next.profile_revision < previous.profile_revision) {
          throw new Error(
            `device permission profile revision regressed from ${previous.profile_revision} `
            + `to ${next.profile_revision}`,
          );
        } else if (next.profile_revision === previous.profile_revision
          && !permissionSnapshotsEqual(previous, next)) {
          throw new Error("device permission content changed without a profile revision increase");
        }
      }
      if (next.permission_version === previous.permission_version
        && permissionSnapshotsEqual(previous, next)) {
        this.options.config.saveCloudPermissionSnapshot(next);
        this.permissionSnapshot = next;
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

  private permissionState(): Pick<
    DesktopCloudState,
    | "permission_status"
    | "permission_profile"
    | "permission_version"
    | "profile_revision"
    | "profile_labels"
    | "desktop_features"
    | "permission_verified_at"
  > {
    const snapshot = this.permissionSnapshot;
    return {
      permission_status: !snapshot
        ? this.permissionFailure ?? "pending_verification"
        : this.permissionFresh
          ? snapshot.permission_profile === null ? "unassigned" : "verified"
          : "cached",
      permission_profile: snapshot?.permission_profile ?? null,
      permission_version: snapshot?.permission_version ?? 0,
      profile_revision: snapshot?.profile_revision ?? 0,
      profile_labels: { ...(snapshot?.profile_labels ?? {}) },
      desktop_features: [...(snapshot?.desktop_features ?? [])],
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
    this.connection = connection;
    this.isAdmin = isAdmin;
    this.lastError = lastError;
    if (checked) this.lastCheckedAt = Math.floor(this.now() / 1_000);
    return this.publishState();
  }

  private publishState(): DesktopCloudState {
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (serialized !== this.lastPublished) {
      this.lastPublished = serialized;
      this.options.onStateChanged?.(state);
    }
    return state;
  }

  private setDependencyStatus(status: WireGuardDependencyStatus): DesktopCloudState {
    this.dependencyState = status.state;
    this.dependencyError = status.error;
    return this.publishState();
  }

  private async reconnectOnce(): Promise<DesktopCloudState> {
    if (this.activation) return this.activation;
    const cloud = this.options.config.cloudConfiguration();
    if (!cloud.managed) return this.checkConnection(true);
    const configuration = this.options.config.cloudWireGuardConfiguration();
    if (!configuration) {
      // Manually configured administrator tunnels are owned outside this application.
      return this.checkConnection(true);
    }
    this.setConnection("connecting", "");
    try {
      await this.options.provisioner.reconnect!(configuration, randomUUID());
    } catch (error) {
      const message = this.publicError(error);
      this.setConnection("error", message);
      throw new Error(message);
    }
    return this.checkConnection(true);
  }

  private unsupportedMessage(): string {
    return this.options.unsupportedMessage ?? "公司云端仅支持 Windows 10/11 x64 安装包";
  }

  private diagnosticError(error: unknown, target?: CloudProbeTarget): string {
    const message = error instanceof Error ? error.message : String(error);
    const sanitized = message.replace(/\blxe_(?:(?:dev|client|identity)_[A-Za-z0-9]+\.|(?:erp_run|erp_handoff|erp_session|run|handoff|session)_)[A-Za-z0-9_-]+\b/gu, "[redacted]");
    return target ? this.redactSensitiveText(sanitized, target) : sanitized.trim().slice(0, 500);
  }

  private redactSensitiveText(value: string, target: CloudProbeTarget): string {
    let redacted = value.trim();
    for (const sensitive of [target.apiToken, target.dataServerUrl].filter(Boolean)) {
      redacted = redacted.replaceAll(sensitive, "[redacted]");
    }
    return redacted.slice(0, 500);
  }

  private publicError(error: unknown): string {
    return this.diagnosticError(error).slice(0, 300);
  }
}
