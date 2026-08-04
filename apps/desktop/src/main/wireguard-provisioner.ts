import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import { resolveMachineIdentity } from "@lxe/core/machine-identity";
import type { CloudEnrollmentPayload } from "./cloud-enrollment";

export interface WindowsWireGuardProvisionerOptions {
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  dataRoot: string;
  resourcesPath: string;
  logger: Logger;
  now?: () => number;
  runElevated?: (scriptPath: string, arguments_: readonly string[]) => Promise<void>;
}

export interface WireGuardProvisionerPort {
  provision(payload: CloudEnrollmentPayload, activationId: string): Promise<void>;
}

interface WireGuardProvisionResult {
  ok?: unknown;
  message?: unknown;
  connection?: unknown;
  failed_stage?: unknown;
}

interface ElevatedPowerShellError extends Error {
  diagnosticMessage?: string;
  exitCode?: string | number;
}

const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const windowsCommandLineQuote = (value: string): string =>
  `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;

const runElevatedPowerShell = (scriptPath: string, arguments_: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const elevatedArguments = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...arguments_,
    ];
    const argumentLine = elevatedArguments.map(windowsCommandLineQuote).join(" ");
    const command = [
      `$arguments = ${powershellQuote(argumentLine)}`,
      "try {",
      "  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru",
      "  exit $process.ExitCode",
      "} catch {",
      "  Write-Error $_.Exception.Message",
      "  exit 1223",
      "}",
    ].join("\n");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = String(stderr ?? "").trim();
        const exitCode = (error as NodeJS.ErrnoException & { code?: string | number }).code;
        const failure = new Error(detail.includes("canceled") || String(exitCode) === "1223"
          ? "管理员授权已取消"
          : "WireGuard 配置未完成") as ElevatedPowerShellError;
        failure.diagnosticMessage = detail || error.message;
        if (exitCode !== undefined) failure.exitCode = exitCode;
        reject(failure);
      },
    );
  });

const boundedDiagnostic = (value: unknown): string => {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.trim().slice(0, 500);
};

const redactedProvisionDiagnostic = (
  value: unknown,
  payload: CloudEnrollmentPayload,
): string => {
  let message = boundedDiagnostic(value);
  for (const secret of [
    payload.wireguard.private_key,
    payload.data_server.api_token,
    payload.erp?.api_token ?? "",
  ]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message;
};

const publicProvisionFailure = (
  message: string,
  failedStage: string,
  elevatedError: ElevatedPowerShellError | undefined,
  fallbackDiagnostic: string,
): Error => {
  if (message.includes("already bound to another computer")) {
    return new Error("该设备文件已绑定到另一台电脑");
  }
  if (message.includes("rejected this device credential")) {
    return new Error("设备凭证已失效，请联系管理员");
  }
  if (message) {
    return new Error(`WireGuard 配置失败（${failedStage}）：${message}`.slice(0, 700));
  }
  if (elevatedError?.message === "管理员授权已取消") return elevatedError;
  if (fallbackDiagnostic && fallbackDiagnostic !== elevatedError?.message) {
    return new Error(`WireGuard 配置失败（${failedStage}）：${fallbackDiagnostic}`.slice(0, 700));
  }
  if (elevatedError) return elevatedError;
  if (fallbackDiagnostic) {
    return new Error(`WireGuard 配置失败（${failedStage}）：${fallbackDiagnostic}`.slice(0, 700));
  }
  return new Error("WireGuard 配置未完成，请重试或联系管理员");
};

const readProvisionResult = (path: string): { result?: WireGuardProvisionResult; error?: string } => {
  try {
    return {
      result: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, "")) as WireGuardProvisionResult,
    };
  } catch (error) {
    return { error: boundedDiagnostic(error) };
  }
};

export const wireGuardConfiguration = (payload: CloudEnrollmentPayload): string => [
  "[Interface]",
  `PrivateKey = ${payload.wireguard.private_key}`,
  `Address = ${payload.wireguard.address}`,
  "",
  "[Peer]",
  `PublicKey = ${payload.wireguard.server_public_key}`,
  `AllowedIPs = ${payload.wireguard.allowed_ips.join(", ")}`,
  `Endpoint = ${payload.wireguard.endpoint}`,
  `PersistentKeepalive = ${payload.wireguard.persistent_keepalive}`,
  "",
].join("\r\n");

export class WindowsWireGuardProvisioner {
  private readonly runElevated: (scriptPath: string, arguments_: readonly string[]) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: WindowsWireGuardProvisionerOptions) {
    this.runElevated = options.runElevated ?? runElevatedPowerShell;
    this.now = options.now ?? Date.now;
  }

  supported(): boolean {
    return this.options.packaged && this.options.platform === "win32" && this.options.arch === "x64";
  }

  async provision(payload: CloudEnrollmentPayload, activationId: string): Promise<void> {
    const startedAt = this.now();
    const vpnIp = payload.wireguard.address.replace(/\/32$/u, "");
    const logger = this.options.logger.child({
      activation_id: activationId,
      device_id: payload.device.id,
      vpn_ip: vpnIp,
    });
    logger.info("wireguard_provision_started", {
      platform: this.options.platform,
      arch: this.options.arch,
      packaged: this.options.packaged,
    });
    if (!this.supported()) {
      const error = new Error("公司云端仅支持 Windows 10/11 x64 安装包");
      logger.error("wireguard_provision_failed", {
        failed_stage: "validate_host",
        duration_ms: Math.max(0, this.now() - startedAt),
        observed_error: error.message,
      });
      throw error;
    }
    const wireGuardRoot = join(this.options.resourcesPath, "wireguard");
    const msiPath = join(wireGuardRoot, "wireguard-amd64-1.1.msi");
    const scriptPath = join(wireGuardRoot, "provision-wireguard.ps1");
    if (!existsSync(msiPath) || !existsSync(scriptPath)) {
      const error = new Error("安装包缺少 WireGuard 资源，请联系管理员");
      logger.error("wireguard_provision_failed", {
        failed_stage: "validate_resources",
        duration_ms: Math.max(0, this.now() - startedAt),
        observed_error: error.message,
      });
      throw error;
    }
    const stagingRoot = join(this.options.dataRoot, "config", ".cloud-provisioning");
    mkdirSync(stagingRoot, { recursive: true });
    const id = randomUUID();
    const configPath = join(stagingRoot, `${id}.conf`);
    const activationPath = join(stagingRoot, `${id}.activation.json`);
    const resultPath = join(stagingRoot, `${id}.json`);
    let stage = "stage_configuration";
    let failureLogged = false;
    try {
      writeFileSync(configPath, wireGuardConfiguration(payload), { encoding: "utf8", mode: 0o600 });
      chmodSync(configPath, 0o600);
      const identity = resolveMachineIdentity(join(this.options.dataRoot, "db", "machine_identity.json"));
      writeFileSync(activationPath, JSON.stringify({
        url: payload.data_server.url,
        api_token: payload.data_server.api_token,
        machine_id: identity.machine_id,
        hostname: hostname(),
        device_id: payload.device.id,
        wireguard_ip: vpnIp,
      }), { encoding: "utf8", mode: 0o600 });
      chmodSync(activationPath, 0o600);
      stage = "elevated_process";
      let elevatedError: ElevatedPowerShellError | undefined;
      try {
        await this.runElevated(scriptPath, [
          "-MsiPath",
          msiPath,
          "-ConfigPath",
          configPath,
          "-ActivationPath",
          activationPath,
          "-ResultPath",
          resultPath,
        ]);
      } catch (error) {
        elevatedError = error instanceof Error ? error as ElevatedPowerShellError : new Error(String(error));
      }
      stage = "read_result";
      const resultRead = readProvisionResult(resultPath);
      const result = resultRead.result;
      if (elevatedError || result?.ok !== true) {
        const message = String(result?.message ?? "");
        const observedError = message && message !== "ok"
          ? redactedProvisionDiagnostic(message, payload)
          : redactedProvisionDiagnostic(
              elevatedError?.diagnosticMessage || elevatedError || resultRead.error,
              payload,
            );
        const failedStage = String(result?.failed_stage ?? "").trim() || stage;
        failureLogged = true;
        logger.error("wireguard_provision_failed", {
          failed_stage: failedStage,
          duration_ms: Math.max(0, this.now() - startedAt),
          ...(elevatedError?.exitCode === undefined ? {} : { process_exit_code: elevatedError.exitCode }),
          observed_error: observedError || "WireGuard provisioning failed without a diagnostic result",
        });
        throw publicProvisionFailure(
          message && message !== "ok" ? observedError : "",
          failedStage,
          elevatedError,
          observedError,
        );
      }
      logger.info("wireguard_provision_completed", {
        duration_ms: Math.max(0, this.now() - startedAt),
        connection: String(result.connection ?? "unknown").slice(0, 32),
      });
    } catch (error) {
      if (!failureLogged) {
        logger.error("wireguard_provision_failed", {
          failed_stage: stage,
          duration_ms: Math.max(0, this.now() - startedAt),
          observed_error: boundedDiagnostic(error),
        });
      }
      throw error;
    } finally {
      rmSync(configPath, { force: true });
      rmSync(activationPath, { force: true });
      rmSync(resultPath, { force: true });
    }
  }
}
