import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { resolveMachineIdentity } from "@lxe/runtime/machine-identity";
import type { CloudEnrollmentPayload } from "./cloud-enrollment";

export interface WindowsWireGuardProvisionerOptions {
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  dataRoot: string;
  resourcesPath: string;
  runElevated?: (scriptPath: string, arguments_: readonly string[]) => Promise<void>;
}

export interface WireGuardProvisionerPort {
  provision(payload: CloudEnrollmentPayload): Promise<void>;
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
        reject(new Error(detail.includes("canceled") || (error as NodeJS.ErrnoException).code === "1223"
          ? "管理员授权已取消"
          : "WireGuard 配置未完成"));
      },
    );
  });

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

  constructor(private readonly options: WindowsWireGuardProvisionerOptions) {
    this.runElevated = options.runElevated ?? runElevatedPowerShell;
  }

  supported(): boolean {
    return this.options.packaged && this.options.platform === "win32" && this.options.arch === "x64";
  }

  async provision(payload: CloudEnrollmentPayload): Promise<void> {
    if (!this.supported()) throw new Error("公司云端仅支持 Windows 10/11 x64 安装包");
    const wireGuardRoot = join(this.options.resourcesPath, "wireguard");
    const msiPath = join(wireGuardRoot, "wireguard-amd64-1.1.msi");
    const scriptPath = join(wireGuardRoot, "provision-wireguard.ps1");
    if (!existsSync(msiPath) || !existsSync(scriptPath)) {
      throw new Error("安装包缺少 WireGuard 资源，请联系管理员");
    }
    const stagingRoot = join(this.options.dataRoot, "config", ".cloud-provisioning");
    mkdirSync(stagingRoot, { recursive: true });
    const id = randomUUID();
    const configPath = join(stagingRoot, `${id}.conf`);
    const activationPath = join(stagingRoot, `${id}.activation.json`);
    const resultPath = join(stagingRoot, `${id}.json`);
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
        wireguard_ip: payload.wireguard.address.replace(/\/32$/u, ""),
      }), { encoding: "utf8", mode: 0o600 });
      chmodSync(activationPath, 0o600);
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
      const result = JSON.parse(readFileSync(resultPath, "utf8").replace(/^\uFEFF/u, "")) as {
        ok?: unknown;
        message?: unknown;
      };
      if (result.ok !== true) {
        const message = String(result.message ?? "");
        if (message.includes("already bound to another computer")) {
          throw new Error("该设备文件已绑定到另一台电脑");
        }
        if (message.includes("rejected this device credential")) {
          throw new Error("设备凭证已失效，请联系管理员");
        }
        throw new Error("WireGuard 配置未完成，请重试或联系管理员");
      }
    } finally {
      rmSync(configPath, { force: true });
      rmSync(activationPath, { force: true });
      rmSync(resultPath, { force: true });
    }
  }
}
