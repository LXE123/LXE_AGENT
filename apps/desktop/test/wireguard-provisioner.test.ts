import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudEnrollmentPayload } from "../src/main/cloud-enrollment";
import { WindowsWireGuardProvisioner, windowsCommandLineQuote } from "../src/main/wireguard-provisioner";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const payload: CloudEnrollmentPayload = {
  device: { id: "0123456789abcdef0123456789abcdef", name: "Finance-PC-01" },
  wireguard: {
    private_key: Buffer.alloc(32, 1).toString("base64"),
    address: "10.88.0.8/32",
    server_public_key: Buffer.alloc(32, 2).toString("base64"),
    endpoint: "43.139.140.124:51820",
    allowed_ips: ["10.88.0.1/32"],
    persistent_keepalive: 25,
  },
  data_server: {
    url: "http://10.88.0.1:8000",
    api_token: "lxe_dev_0123456789abcdef0123456789abcdef.secret-value",
    sync_interval_seconds: 3_600,
  },
};

describe("WindowsWireGuardProvisioner", () => {
  test("quotes elevated Windows arguments without losing paths containing spaces", () => {
    expect(windowsCommandLineQuote("C:\\Program Files\\LXE Agent\\wireguard.msi"))
      .toBe('"C:\\Program Files\\LXE Agent\\wireguard.msi"');
    expect(windowsCommandLineQuote('C:\\tmp\\a"b\\'))
      .toBe('"C:\\tmp\\a\\"b\\\\"');
  });

  test("passes a narrow split-tunnel config to one elevated operation and removes plaintext", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-wireguard-provision-"));
    roots.push(root);
    const resources = join(root, "resources", "wireguard");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "wireguard-amd64-1.1.msi"), "msi");
    writeFileSync(join(resources, "provision-wireguard.ps1"), "script");
    let calls = 0;
    const provisioner = new WindowsWireGuardProvisioner({
      platform: "win32",
      arch: "x64",
      packaged: true,
      dataRoot: join(root, "data"),
      resourcesPath: join(root, "resources"),
      runElevated: async (_script, arguments_) => {
        calls += 1;
        const configPath = arguments_[arguments_.indexOf("-ConfigPath") + 1]!;
        const activationPath = arguments_[arguments_.indexOf("-ActivationPath") + 1]!;
        const resultPath = arguments_[arguments_.indexOf("-ResultPath") + 1]!;
        const configuration = readFileSync(configPath, "utf8");
        expect(configuration).toContain(`PrivateKey = ${payload.wireguard.private_key}`);
        expect(configuration).toContain("AllowedIPs = 10.88.0.1/32");
        expect(configuration).not.toContain("0.0.0.0/0");
        const activation = JSON.parse(readFileSync(activationPath, "utf8")) as Record<string, string>;
        expect(activation.api_token).toBe(payload.data_server.api_token);
        expect(activation.machine_id).toMatch(/^[a-f0-9-]{32,}$/u);
        writeFileSync(resultPath, JSON.stringify({ ok: true, message: "ok", connection: "connected" }));
      },
    });

    await provisioner.provision(payload);
    expect(calls).toBe(1);
    const staging = join(root, "data", "config", ".cloud-provisioning");
    expect(existsSync(staging)).toBe(true);
    expect(readdirSync(staging)).toEqual([]);
  });

  test("rejects unsupported hosts before creating any plaintext", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-wireguard-unsupported-"));
    roots.push(root);
    const provisioner = new WindowsWireGuardProvisioner({
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      dataRoot: join(root, "data"),
      resourcesPath: join(root, "resources"),
    });
    await expect(provisioner.provision(payload)).rejects.toThrow("Windows 10/11 x64");
    expect(existsSync(join(root, "data"))).toBe(false);
  });

  test("reports a device binding conflict without exposing elevated-script details", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-wireguard-conflict-"));
    roots.push(root);
    const resources = join(root, "resources", "wireguard");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "wireguard-amd64-1.1.msi"), "msi");
    writeFileSync(join(resources, "provision-wireguard.ps1"), "script");
    const provisioner = new WindowsWireGuardProvisioner({
      platform: "win32",
      arch: "x64",
      packaged: true,
      dataRoot: join(root, "data"),
      resourcesPath: join(root, "resources"),
      runElevated: async (_script, arguments_) => {
        const resultPath = arguments_[arguments_.indexOf("-ResultPath") + 1]!;
        writeFileSync(resultPath, JSON.stringify({
          ok: false,
          message: "This device file is already bound to another computer: secret detail",
        }));
      },
    });

    await expect(provisioner.provision(payload)).rejects.toThrow("该设备文件已绑定到另一台电脑");
    expect(readdirSync(join(root, "data", "config", ".cloud-provisioning"))).toEqual([]);
  });
});
