import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("packaged WireGuard resources", () => {
  test("downloads and stages the official x64 MSI without checksum or signature gates", () => {
    const prepare = readFileSync(resolve(repositoryRoot, "scripts/prepare-wireguard-windows.ps1"), "utf8");
    const staging = readFileSync(resolve(repositoryRoot, "scripts/prepare-desktop-resources.ts"), "utf8");
    expect(prepare).toContain("https://download.wireguard.com/windows-client/wireguard-amd64-1.1.msi");
    expect(prepare).not.toMatch(/SHA-?256|Get-AuthenticodeSignature|WireGuard LLC/iu);
    expect(staging).not.toMatch(/wireGuardSha|WireGuard.*SHA-?256/iu);
    expect(staging).toContain("wireguard-amd64-1.1.msi");
  });

  test("uses the official DPAPI secure store and a persistent tunnel service", () => {
    const provision = readFileSync(
      resolve(repositoryRoot, "apps/desktop/resources/wireguard/provision-wireguard.ps1"),
      "utf8",
    );
    expect(provision).toContain("/installmanagerservice");
    expect(provision).not.toContain("Get-AuthenticodeSignature");
    expect(provision).toContain("$SecureConfiguration = \"$PlainConfiguration.dpapi\"");
    expect(provision).toContain("/installtunnelservice");
    expect(provision).toContain("WireGuardTunnel`$$TunnelName");
    expect(provision).toContain("function Test-WireGuardVersionSupported");
    expect(provision).toContain("$VersionText -notmatch '^\\s*(\\d+)\\.(\\d+)'");
    expect(provision).toContain("$major -gt 1 -or ($major -eq 1 -and $minor -ge 1)");
    expect(provision).toContain("$requiresInstall = -not (Test-WireGuardVersionSupported $currentVersion)");
    expect(provision).toContain("if (-not (Test-WireGuardVersionSupported $installedVersion))");
    expect(provision).not.toContain('[version]"1.1.0"');
    expect(provision).toContain("$BackupConfiguration");
    expect(provision).toContain("$managerInstalledHere");
    expect(provision).toContain("/api/v1/agent-data/devices/activate");
    expect(provision).toContain("This device file is already bound to another computer");
    for (const stage of [
      "validate_host",
      "inspect_installation",
      "install_wireguard",
      "ensure_manager",
      "stage_configuration",
      "secure_configuration",
      "install_tunnel",
      "start_tunnel",
      "activate_device",
    ]) {
      expect(provision).toContain(`$Stage = "${stage}"`);
    }
    expect(provision).toContain("$result.failed_stage = $FailedStage");
  });

  test("ships a narrow elevated cleanup for only the LXE-managed tunnel", () => {
    const cleanup = readFileSync(
      resolve(repositoryRoot, "apps/desktop/resources/wireguard/remove-lxe-tunnel.ps1"),
      "utf8",
    );
    const staging = readFileSync(resolve(repositoryRoot, "scripts/prepare-desktop-resources.ts"), "utf8");
    expect(cleanup).toContain('$TunnelName = "lxe-agent"');
    expect(cleanup).toContain("/uninstalltunnelservice $TunnelName");
    expect(cleanup).toContain("-Verb RunAs");
    expect(cleanup).toContain("$SecureConfiguration");
    expect(cleanup).not.toContain("/uninstallmanagerservice");
    expect(cleanup).not.toContain("msiexec");
    expect(staging).toContain("remove-lxe-tunnel.ps1");
  });
});
