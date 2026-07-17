import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("packaged WireGuard resources", () => {
  test("pins the official x64 MSI and verifies hash plus Authenticode before staging", () => {
    const prepare = readFileSync(resolve(repositoryRoot, "scripts/prepare-wireguard-windows.ps1"), "utf8");
    const staging = readFileSync(resolve(repositoryRoot, "scripts/prepare-desktop-resources.ts"), "utf8");
    const hash = "6daa5d37a9e2950dfb8c48b95ab8e562cb2bad1c785d020f38f97bea4c6a5566";
    expect(prepare).toContain("https://download.wireguard.com/windows-client/wireguard-amd64-1.1.msi");
    expect(prepare).toContain(hash);
    expect(prepare).toContain("[System.Security.Cryptography.SHA256]::Create()");
    expect(prepare).not.toContain("Get-FileHash");
    expect(prepare).toContain("Join-Path $PSHOME");
    expect(prepare).toContain("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature");
    expect(prepare).toContain("WireGuard LLC");
    expect(staging).toContain(hash);
    expect(staging).toContain("wireguard-amd64-1.1.msi");
  });

  test("uses the official DPAPI secure store and a persistent tunnel service", () => {
    const provision = readFileSync(
      resolve(repositoryRoot, "apps/desktop/resources/wireguard/provision-wireguard.ps1"),
      "utf8",
    );
    expect(provision).toContain("/installmanagerservice");
    expect(provision).toContain("Join-Path $PSHOME");
    expect(provision).toContain("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature");
    expect(provision).toContain("$SecureConfiguration = \"$PlainConfiguration.dpapi\"");
    expect(provision).toContain("/installtunnelservice");
    expect(provision).toContain("WireGuardTunnel`$$TunnelName");
    expect(provision).toContain("$currentVersion -lt [version]\"1.1.0\"");
    expect(provision).toContain("$BackupConfiguration");
    expect(provision).toContain("$managerInstalledHere");
    expect(provision).toContain("/api/v1/agent-data/devices/activate");
    expect(provision).toContain("This device file is already bound to another computer");
  });
});
