import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@lxe/core";
import type { CloudEnrollmentPayload } from "../src/main/cloud-enrollment";
import {
  MACOS_WIREGUARD_PATHS,
  MacOSWireGuardProvisioner,
  type MacOSWireGuardCommand,
} from "../src/main/macos-wireguard-provisioner";
import { WireGuardProvisioningError } from "../src/main/wireguard-provisioner";
import { wireGuardTunnelFromEnrollment } from "../src/main/wireguard-types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type LogEvent = { level: string; message: string; fields: Record<string, unknown> };
const testLogger = (events: LogEvent[], parent: Record<string, unknown> = {}): Logger => ({
  debug: (message, fields = {}) => events.push({ level: "debug", message, fields: { ...parent, ...fields } }),
  info: (message, fields = {}) => events.push({ level: "info", message, fields: { ...parent, ...fields } }),
  warn: (message, fields = {}) => events.push({ level: "warn", message, fields: { ...parent, ...fields } }),
  error: (message, fields = {}) => events.push({ level: "error", message, fields: { ...parent, ...fields } }),
  child: (fields) => testLogger(events, { ...parent, ...fields }),
});

const payload: CloudEnrollmentPayload = {
  enrollment_version: 1,
  device: { id: "0123456789abcdef0123456789abcdef", name: "Finance-Mac-01" },
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

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-macos-wireguard-"));
  roots.push(root);
  return root;
};

const allTools = (): Set<string> => new Set(Object.values(MACOS_WIREGUARD_PATHS));

describe("MacOSWireGuardProvisioner", () => {
  test("supports only unpackaged Apple Silicon and reports dependency state", () => {
    const root = createRoot();
    const events: LogEvent[] = [];
    const arm = new MacOSWireGuardProvisioner({
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      dataRoot: root,
      logger: testLogger(events),
      pathIsExecutable: () => false,
    });
    expect(arm.supported()).toBeTrue();
    expect(arm.dependencyStatus()).toEqual({ state: "homebrew_missing", error: "" });

    for (const [platform, arch, packaged] of [
      ["darwin", "x64", false],
      ["darwin", "arm64", true],
      ["win32", "arm64", false],
    ] as const) {
      const unsupported = new MacOSWireGuardProvisioner({
        platform,
        arch,
        packaged,
        dataRoot: root,
        logger: testLogger(events),
        pathIsExecutable: () => false,
      });
      expect(unsupported.supported()).toBeFalse();
      expect(unsupported.dependencyStatus().state).toBe("not_required");
    }
  });

  test("opens visible Homebrew setup, installs wireguard-tools with a fixed executable, and verifies tools", async () => {
    const root = createRoot();
    const events: LogEvent[] = [];
    const executablePaths = new Set<string>();
    const states: string[] = [];
    let installerOpened = 0;
    let now = 0;
    const processCalls: Array<{ path: string; arguments_: readonly string[] }> = [];
    const provisioner = new MacOSWireGuardProvisioner({
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      dataRoot: root,
      logger: testLogger(events),
      pathIsExecutable: (path) => executablePaths.has(path),
      openHomebrewInstaller: async () => { installerOpened += 1; },
      wait: async (milliseconds) => {
        now += milliseconds;
        executablePaths.add(MACOS_WIREGUARD_PATHS.brew);
      },
      now: () => now,
      pollIntervalMs: 10,
      homebrewWaitMs: 100,
      runProcess: async (path, arguments_) => {
        processCalls.push({ path, arguments_ });
        executablePaths.add(MACOS_WIREGUARD_PATHS.wg);
        executablePaths.add(MACOS_WIREGUARD_PATHS.wgQuick);
        executablePaths.add(MACOS_WIREGUARD_PATHS.wireguardGo);
        return { stdout: "installed", stderr: "" };
      },
    });

    const status = await provisioner.prepareDependencies((next) => states.push(next.state));

    expect(installerOpened).toBe(1);
    expect(processCalls).toEqual([{
      path: "/opt/homebrew/bin/brew",
      arguments_: ["install", "wireguard-tools"],
    }]);
    expect(states).toEqual([
      "homebrew_missing",
      "installing_homebrew",
      "installing_wireguard_tools",
      "ready",
    ]);
    expect(status).toEqual({ state: "ready", error: "" });
  });

  test("exposes a bounded dependency installation error and allows a later retry", async () => {
    const root = createRoot();
    const executablePaths = new Set([MACOS_WIREGUARD_PATHS.brew]);
    let fail = true;
    const provisioner = new MacOSWireGuardProvisioner({
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      dataRoot: root,
      logger: testLogger([]),
      pathIsExecutable: (path) => executablePaths.has(path),
      runProcess: async () => {
        if (fail) throw new Error(`brew failed ${"x".repeat(700)}`);
        executablePaths.add(MACOS_WIREGUARD_PATHS.wg);
        executablePaths.add(MACOS_WIREGUARD_PATHS.wgQuick);
        executablePaths.add(MACOS_WIREGUARD_PATHS.wireguardGo);
        return { stdout: "installed", stderr: "" };
      },
    });

    const failed = await provisioner.prepareDependencies(() => undefined);
    expect(failed.state).toBe("error");
    expect(failed.error.length).toBeLessThanOrEqual(500);
    fail = false;
    expect(await provisioner.prepareDependencies(() => undefined)).toEqual({ state: "ready", error: "" });
  });

  test("stages 0600 plaintext only for the elevated up operation and removes it afterwards", async () => {
    const root = createRoot();
    const events: LogEvent[] = [];
    const calls: MacOSWireGuardCommand[][] = [];
    const provisioner = new MacOSWireGuardProvisioner({
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      dataRoot: root,
      logger: testLogger(events),
      pathIsExecutable: (path) => allTools().has(path),
      runElevated: async (commands) => {
        calls.push([...commands]);
        expect(commands.map(({ action }) => action)).toEqual(["down", "up"]);
        expect(commands[0]?.ignoreFailure).toBeTrue();
        const configPath = commands[1]!.configPath;
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        expect(statSync(join(configPath, "..", "..")).mode & 0o777).toBe(0o700);
        const configuration = readFileSync(configPath, "utf8");
        expect(configuration).toContain(`PrivateKey = ${payload.wireguard.private_key}`);
        expect(configuration).toContain("AllowedIPs = 10.88.0.1/32");
      },
    });

    await provisioner.provision(payload, "mac-activation");

    expect(calls).toHaveLength(1);
    expect(readdirSync(join(root, "config", ".cloud-wireguard"))).toEqual([]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(payload.wireguard.private_key);
    expect(serialized).not.toContain(payload.data_server.api_token);
  });

  test("reconnects from the stored configuration with down then up", async () => {
    const root = createRoot();
    const commands: MacOSWireGuardCommand[][] = [];
    const provisioner = new MacOSWireGuardProvisioner({
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      dataRoot: root,
      logger: testLogger([]),
      pathIsExecutable: (path) => allTools().has(path),
      runElevated: async (next) => { commands.push([...next]); },
    });

    await provisioner.reconnect(wireGuardTunnelFromEnrollment(payload), "reconnect-1");

    expect(commands).toHaveLength(1);
    expect(commands[0]?.map(({ action }) => action)).toEqual(["down", "up"]);
    expect(commands[0]?.[0]?.configPath).toBe(commands[0]?.[1]?.configPath);
    expect(readdirSync(join(root, "config", ".cloud-wireguard"))).toEqual([]);
  });

  test("restores the previous tunnel after replacement failure and reports whether rollback failed", async () => {
    const previousPayload: CloudEnrollmentPayload = {
      ...payload,
      wireguard: {
        ...payload.wireguard,
        private_key: Buffer.alloc(32, 9).toString("base64"),
        address: "10.88.0.9/32",
      },
    };
    for (const rollbackFails of [false, true]) {
      const root = createRoot();
      let call = 0;
      const events: LogEvent[] = [];
      const provisioner = new MacOSWireGuardProvisioner({
        platform: "darwin",
        arch: "arm64",
        packaged: false,
        dataRoot: root,
        logger: testLogger(events),
        pathIsExecutable: (path) => allTools().has(path),
        runElevated: async () => {
          call += 1;
          if (call === 1 || rollbackFails) throw new Error(`failed ${payload.wireguard.private_key}`);
        },
      });
      let failure: unknown;
      try {
        await provisioner.provision(
          payload,
          `replacement-${String(rollbackFails)}`,
          wireGuardTunnelFromEnrollment(previousPayload),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(WireGuardProvisioningError);
      expect(failure).toMatchObject({ previousRemoved: rollbackFails });
      expect(call).toBe(2);
      expect(JSON.stringify(events)).not.toContain(payload.wireguard.private_key);
      expect(readdirSync(join(root, "config", ".cloud-wireguard"))).toEqual([]);
    }
  });

  test("does not tear down or roll back the old tunnel when administrator authorization is canceled", async () => {
    const root = createRoot();
    let calls = 0;
    const provisioner = new MacOSWireGuardProvisioner({
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      dataRoot: root,
      logger: testLogger([]),
      pathIsExecutable: (path) => allTools().has(path),
      runElevated: async () => {
        calls += 1;
        throw new Error("管理员授权已取消");
      },
    });

    let failure: unknown;
    try {
      await provisioner.provision(
        payload,
        "authorization-cancel",
        wireGuardTunnelFromEnrollment({
          ...payload,
          wireguard: { ...payload.wireguard, address: "10.88.0.9/32" },
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "管理员授权已取消", previousRemoved: false });
    expect(calls).toBe(1);
    expect(readdirSync(join(root, "config", ".cloud-wireguard"))).toEqual([]);
  });
});
