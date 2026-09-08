import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  accessSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import serviceScript from "../../resources/wireguard/macos-service.sh" with { type: "text" };
import type { Logger } from "@lxe/core";
import type { CloudEnrollmentPayload } from "./cloud-enrollment";
import {
  WireGuardProvisioningError,
  type WireGuardDependencyStatus,
  type WireGuardProvisionerPort,
} from "./wireguard-provisioner";
import {
  wireGuardConfiguration,
  wireGuardTunnelFromEnrollment,
  type WireGuardTunnelConfiguration,
} from "./wireguard-types";

const BREW_PATH = "/opt/homebrew/bin/brew";
const WG_PATH = "/opt/homebrew/bin/wg";
const WG_QUICK_PATH = "/opt/homebrew/bin/wg-quick";
const WIREGUARD_GO_PATH = "/opt/homebrew/bin/wireguard-go";
const OSASCRIPT_PATH = "/usr/bin/osascript";
const HOMEBREW_COMMAND_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const HOMEBREW_INSTALL_COMMAND = "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"";

export interface MacOSWireGuardCommand {
  action: "install";
  configPath: string;
  previousConfigPath?: string;
  scriptPath: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface MacOSWireGuardProvisionerOptions {
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  dataRoot: string;
  logger: Logger;
  pathIsExecutable?: (path: string) => boolean;
  runProcess?: (path: string, arguments_: readonly string[], timeoutMs: number) => Promise<ProcessResult>;
  runElevated?: (commands: readonly MacOSWireGuardCommand[]) => Promise<void>;
  openHomebrewInstaller?: () => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  homebrewWaitMs?: number;
  now?: () => number;
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const runProcess = (
  path: string,
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<ProcessResult> => new Promise((resolve, reject) => {
  execFile(
    path,
    [...arguments_],
    {
      timeout: timeoutMs,
      env: {
        ...process.env,
        PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
    },
    (error, stdout, stderr) => {
      if (error) {
        const failure = error as Error & { stderr?: string; stdout?: string };
        failure.stderr = String(stderr ?? "");
        failure.stdout = String(stdout ?? "");
        reject(failure);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    },
  );
});

const appleScriptString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const defaultRunElevated = async (commands: readonly MacOSWireGuardCommand[]): Promise<void> => {
  const command = [
    `PATH=${shellQuote(HOMEBREW_COMMAND_PATH)}`,
    "export PATH",
    ...commands.map((item) => {
      return [shellQuote("/opt/homebrew/bin/bash"), shellQuote(item.scriptPath), "install",
        shellQuote(item.configPath), shellQuote(item.previousConfigPath ?? ""), shellQuote(item.scriptPath)].join(" ");
    }),
  ].join("\n");
  try {
    await runProcess(
      OSASCRIPT_PATH,
      ["-e", `do shell script ${appleScriptString(command)} with administrator privileges`],
      180_000,
    );
  } catch (error) {
    const detail = error instanceof Error
      ? `${error.message} ${(error as Error & { stderr?: string }).stderr ?? ""}`.trim()
      : String(error);
    if (/cancel|取消|-128/iu.test(detail)) throw new Error("管理员授权已取消");
    const stdout = error instanceof Error ? (error as Error & { stdout?: string }).stdout ?? "" : "";
    throw new WireGuardProvisioningError(detail || "WireGuard 管理员命令失败",
      /LXE_WG_PREVIOUS_REMOVED=1/u.test(`${stdout} ${detail}`));
  }
};

const defaultOpenHomebrewInstaller = async (): Promise<void> => {
  await runProcess(
    OSASCRIPT_PATH,
    [
      "-e", "tell application \"Terminal\" to activate",
      "-e", `tell application "Terminal" to do script ${appleScriptString(HOMEBREW_INSTALL_COMMAND)}`,
    ],
    30_000,
  );
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const boundedDiagnostic = (error: unknown): string => {
  const value = error instanceof Error
    ? `${error.message} ${(error as Error & { stderr?: string }).stderr ?? ""}`
    : String(error ?? "");
  return value.replace(/\s+/gu, " ").trim().slice(0, 500);
};

const redactTunnelSecrets = (
  value: string,
  configurations: readonly (WireGuardTunnelConfiguration | null | undefined)[],
): string => configurations.reduce(
  (result, configuration) => configuration?.private_key
    ? result.replaceAll(configuration.private_key, "[redacted]")
    : result,
  value,
);

export class MacOSWireGuardProvisioner implements WireGuardProvisionerPort {
  private readonly pathIsExecutable: (path: string) => boolean;
  private readonly execute: (path: string, arguments_: readonly string[], timeoutMs: number) => Promise<ProcessResult>;
  private readonly runElevated: (commands: readonly MacOSWireGuardCommand[]) => Promise<void>;
  private readonly openHomebrewInstaller: () => Promise<void>;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private status: WireGuardDependencyStatus;
  private preparation: Promise<WireGuardDependencyStatus> | undefined;

  constructor(private readonly options: MacOSWireGuardProvisionerOptions) {
    this.pathIsExecutable = options.pathIsExecutable ?? executable;
    this.execute = options.runProcess ?? runProcess;
    this.runElevated = options.runElevated ?? defaultRunElevated;
    this.openHomebrewInstaller = options.openHomebrewInstaller ?? defaultOpenHomebrewInstaller;
    this.wait = options.wait ?? delay;
    this.now = options.now ?? Date.now;
    this.status = this.scanDependencies();
  }

  supported(): boolean {
    return !this.options.packaged
      && this.options.platform === "darwin"
      && this.options.arch === "arm64";
  }

  dependencyStatus(): WireGuardDependencyStatus {
    return { ...this.status };
  }

  prepareDependencies(
    onChanged: (status: WireGuardDependencyStatus) => void,
  ): Promise<WireGuardDependencyStatus> {
    if (this.preparation) return this.preparation;
    let tracked: Promise<WireGuardDependencyStatus>;
    tracked = this.prepareDependenciesOnce(onChanged).finally(() => {
      if (this.preparation === tracked) this.preparation = undefined;
    });
    this.preparation = tracked;
    return tracked;
  }

  async provision(
    payload: CloudEnrollmentPayload,
    activationId: string,
    previous?: WireGuardTunnelConfiguration | null,
  ): Promise<void> {
    const target = wireGuardTunnelFromEnrollment(payload);
    await this.replaceTunnel(target, previous, activationId, {
      device_id: payload.device.id,
      vpn_ip: target.address.replace(/\/32$/u, ""),
    });
  }

  async reconnect(configuration: WireGuardTunnelConfiguration, operationId: string): Promise<void> {
    await this.replaceTunnel(configuration, null, operationId, {
      vpn_ip: configuration.address.replace(/\/32$/u, ""),
      reconnect: true,
    });
  }

  private scanDependencies(): WireGuardDependencyStatus {
    if (!this.supported()) return { state: "not_required", error: "" };
    if (!this.pathIsExecutable(BREW_PATH)) return { state: "homebrew_missing", error: "" };
    if (![WG_PATH, WG_QUICK_PATH, WIREGUARD_GO_PATH, "/opt/homebrew/bin/bash"].every(this.pathIsExecutable)) {
      return { state: "wireguard_tools_missing", error: "" };
    }
    return { state: "ready", error: "" };
  }

  private emit(
    status: WireGuardDependencyStatus,
    onChanged: (status: WireGuardDependencyStatus) => void,
  ): void {
    this.status = status;
    onChanged({ ...status });
  }

  private async prepareDependenciesOnce(
    onChanged: (status: WireGuardDependencyStatus) => void,
  ): Promise<WireGuardDependencyStatus> {
    const initial = this.scanDependencies();
    this.emit(initial, onChanged);
    if (initial.state === "not_required" || initial.state === "ready") return initial;
    try {
      if (initial.state === "homebrew_missing") {
        this.emit({ state: "installing_homebrew", error: "" }, onChanged);
        await this.openHomebrewInstaller();
        const deadline = this.now() + (this.options.homebrewWaitMs ?? 15 * 60_000);
        while (!this.pathIsExecutable(BREW_PATH) && this.now() < deadline) {
          await this.wait(this.options.pollIntervalMs ?? 2_000);
        }
        if (!this.pathIsExecutable(BREW_PATH)) {
          throw new Error("等待 Homebrew 安装超时；完成 Terminal 中的安装后请重新检测");
        }
      }
      this.emit({ state: "installing_wireguard_tools", error: "" }, onChanged);
      await this.execute(BREW_PATH, ["install", "wireguard-tools"], 15 * 60_000);
      const finalStatus = this.scanDependencies();
      if (finalStatus.state !== "ready") {
        throw new Error("wireguard-tools 安装完成但命令文件不完整");
      }
      this.emit(finalStatus, onChanged);
      return finalStatus;
    } catch (error) {
      const status = { state: "error" as const, error: boundedDiagnostic(error) || "依赖安装失败" };
      this.emit(status, onChanged);
      return status;
    }
  }

  private async replaceTunnel(
    target: WireGuardTunnelConfiguration,
    previous: WireGuardTunnelConfiguration | null | undefined,
    operationId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    if (target.tunnel_name !== "lxe-agent" || (previous && previous.tunnel_name !== "lxe-agent")) {
      throw new WireGuardProvisioningError("WireGuard 系统服务仅支持 lxe-agent 隧道", false);
    }
    const startedAt = this.now();
    const logger = this.options.logger.child({ operation_id: operationId, ...fields });
    if (!this.supported()) throw new WireGuardProvisioningError("公司云端当前仅支持 Apple Silicon Mac 开发版", false);
    const dependencyStatus = this.scanDependencies();
    this.status = dependencyStatus;
    if (dependencyStatus.state !== "ready") {
      throw new WireGuardProvisioningError("请先安装 Homebrew 和 wireguard-tools", false);
    }
    logger.info("wireguard_provision_started", {
      platform: this.options.platform,
      arch: this.options.arch,
      packaged: this.options.packaged,
      reconnect: fields.reconnect === true,
    });
    const stagingRoot = join(this.options.dataRoot, "config", ".cloud-wireguard");
    const operationRoot = join(stagingRoot, randomUUID());
    mkdirSync(operationRoot, { recursive: true, mode: 0o700 });
    chmodSync(stagingRoot, 0o700);
    chmodSync(operationRoot, 0o700);
    try {
      const targetPath = this.stageConfiguration(operationRoot, "target", target);
      const previousPath = previous
        ? this.stageConfiguration(operationRoot, "previous", previous)
        : undefined;
      const scriptPath = join(operationRoot, "service.sh");
      writeFileSync(scriptPath, serviceScript, { encoding: "utf8", mode: 0o700 });
      try {
        await this.runElevated([{
          action: "install", configPath: targetPath, ...(previousPath ? { previousConfigPath: previousPath } : {}), scriptPath,
        }]);
        logger.info("wireguard_provision_completed", {
          duration_ms: Math.max(0, this.now() - startedAt),
          connection: "connected",
          coordination: "launchd",
          previous_removed: Boolean(previous),
        });
      } catch (error) {
        const previousRemoved = error instanceof WireGuardProvisioningError && error.previousRemoved;
        const observedError = boundedDiagnostic(redactTunnelSecrets(
          error instanceof Error ? `${error.message} ${(error as Error & { stderr?: string }).stderr ?? ""}` : String(error),
          [target, previous],
        ));
        logger.error("wireguard_provision_failed", {
          failed_stage: "system_service_install", previous_removed: previousRemoved,
          duration_ms: Math.max(0, this.now() - startedAt), observed_error: observedError,
        });
        throw new WireGuardProvisioningError(observedError === "管理员授权已取消"
          ? observedError : `WireGuard 配置失败：${observedError || "命令执行失败"}`.slice(0, 700), previousRemoved);
      }
    } finally {
      rmSync(operationRoot, { recursive: true, force: true });
    }
  }

  private stageConfiguration(
    operationRoot: string,
    slot: string,
    configuration: WireGuardTunnelConfiguration,
  ): string {
    const directory = join(operationRoot, slot);
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, `${configuration.tunnel_name}.conf`);
    writeFileSync(path, wireGuardConfiguration(configuration), { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
}

export const MACOS_WIREGUARD_PATHS = {
  brew: BREW_PATH,
  wg: WG_PATH,
  wgQuick: WG_QUICK_PATH,
  wireguardGo: WIREGUARD_GO_PATH,
  bash: "/opt/homebrew/bin/bash",
} as const;
