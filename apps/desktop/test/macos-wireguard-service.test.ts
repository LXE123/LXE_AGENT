import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wireGuardConfiguration } from "../src/main/wireguard-types";

const script = resolve(import.meta.dirname, "../resources/wireguard/macos-service.sh");
const bash = "/opt/homebrew/bin/bash";
// Integration tests execute the real controller functions; only privileged OS
// commands and network state are substituted. No production interfaces are used.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const config = (ip = "25") => wireGuardConfiguration({
  tunnel_name: "lxe-agent", private_key: Buffer.alloc(32, 1).toString("base64"),
  server_public_key: Buffer.alloc(32, 2).toString("base64"), address: `10.88.0.${ip}/32`,
  endpoint: "test.example:51820", allowed_ips: ["10.88.0.1/32"], persistent_keepalive: 25,
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-wg-service-")); roots.push(root);
  writeFileSync(join(root, "target"), config());
  writeFileSync(join(root, "previous"), config("24"));
  return root;
};
const setup = `
source "$1"
ROOT=$2; CONFIG="$ROOT/lxe-agent.conf"; SERVICE="$ROOT/service.sh"; LOG="$ROOT/service.log"; PLIST="$ROOT/service.plist"; NAME="$ROOT/lxe-agent.name"
chown() { :; }
install() { command cp "\${@: -2:1}" "\${@: -1}"; command chmod 0600 "\${@: -1}"; }
sleep() { SECONDS=$((SECONDS + 1)); command sleep 0.01; }
launchctl() {
  case "$1" in
    print) [[ -f "$ROOT/loaded" ]] ;;
    print-disabled) echo '{}' ;;
    enable|disable) echo "$1" >> "$ROOT/events" ;;
    bootstrap)
      echo bootstrap >> "$ROOT/events"
      if [[ -f "$ROOT/fail-bootstrap" ]]; then rm "$ROOT/fail-bootstrap"; return 9; fi
      touch "$ROOT/loaded" ;;
    bootout) echo bootout >> "$ROOT/events"; rm -f "$ROOT/loaded" ;;
  esac
}
probe() { [[ -f "$ROOT/loaded" ]] && [[ ! -f "$ROOT/not-ready" ]]; }
interface_name() { [[ -f "$ROOT/legacy" ]] && echo utun99; }
cleanup_tunnel() { echo cleanup >> "$ROOT/events"; rm -f "$ROOT/legacy"; }
`;
function run(root: string, code: string) {
  return spawnSync(bash, ["-c", `${setup}\n${code}`, "test", script, root], { encoding: "utf8", timeout: 10_000 });
}
const install = `install_service "$ROOT/target" "$ROOT/previous" "$1"`;

describe.skipIf(process.platform !== "darwin" || !existsSync(bash))("macOS WireGuard service controller", () => {
  test("installs a persistent config and loads a locally ready service; repeating replaces exactly once", () => {
    const root = fixture();
    for (let i = 0; i < 2; i++) {
      const result = run(root, install);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, "lxe-agent.conf"), "utf8")).toBe(config());
      expect(statSync(join(root, "lxe-agent.conf")).mode & 0o777).toBe(0o600);
      expect(existsSync(join(root, "install.lock"))).toBeTrue();
    }
    const events = readFileSync(join(root, "events"), "utf8");
    expect(events.match(/bootstrap/g)).toHaveLength(2);
    expect(events.match(/bootout/g)).toHaveLength(1);
    const plist = readFileSync(join(root, "service.plist"), "utf8");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).not.toContain(root);
  });

  test("failed update restores the old persistent config and running service within one transaction", () => {
    const root = fixture();
    expect(run(root, install).status).toBe(0);
    writeFileSync(join(root, "target"), config("26"));
    writeFileSync(join(root, "fail-bootstrap"), "");
    const result = run(root, install);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("LXE_WG_PREVIOUS_REMOVED=0");
    expect(readFileSync(join(root, "lxe-agent.conf"), "utf8")).toBe(config());
    expect(existsSync(join(root, "loaded"))).toBeTrue();
  });

  test("failed readiness reports failed rollback rather than pretending the old connection recovered", () => {
    const root = fixture();
    expect(run(root, install).status).toBe(0);
    writeFileSync(join(root, "not-ready"), "");
    const result = run(root, install);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("LXE_WG_PREVIOUS_REMOVED=1");
    expect(result.stderr).toContain("service_readiness_timeout");
  });

  test("legacy replacement failure restores the prior enrollment under supervision", () => {
    const root = fixture();
    writeFileSync(join(root, "legacy"), "");
    writeFileSync(join(root, "fail-bootstrap"), "");
    const result = run(root, install);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("LXE_WG_PREVIOUS_REMOVED=0");
    expect(readFileSync(join(root, "lxe-agent.conf"), "utf8")).toBe(config("24"));
    expect(existsSync(join(root, "loaded"))).toBeTrue();
  });

  test("rejects shell hooks before stopping anything and serializes installations", () => {
    const root = fixture();
    writeFileSync(join(root, "target"), config() + "PostUp = touch /tmp/should-not-exist\n");
    expect(run(root, install).status).not.toBe(0);
    expect(existsSync(join(root, "events"))).toBeFalse();
    writeFileSync(join(root, "target"), config());
    const locked = run(root, `
/usr/bin/lockf -k "$ROOT/install.lock" "$BASH_BIN" -c 'touch "$1/lock-ready"; sleep 1' test "$ROOT" &
while [[ ! -f "$ROOT/lock-ready" ]]; do command sleep 0.01; done
${install}`);
    expect(locked.status).not.toBe(0);
    expect(existsSync(join(root, "events"))).toBeFalse();
  });

  test("recovers stale install locks, rotates bounded logs and redacts key diagnostics", () => {
    const root = fixture();
    const exited = spawnSync(bash, ["-c", "echo $$"], { encoding: "utf8" });
    writeFileSync(join(root, "install.lock"), exited.stdout);
    const recovered = run(root, install);
    expect(recovered.status, recovered.stderr).toBe(0);
    writeFileSync(join(root, "service.log"), "x".repeat(5 * 1024 * 1024 - 30));
    const result = run(root, `log_event 'PrivateKey = ${Buffer.alloc(32, 1).toString("base64")}'`);
    expect(result.status).toBe(0);
    expect(existsSync(join(root, "service.log.1"))).toBeTrue();
    expect(readFileSync(join(root, "service.log"), "utf8")).toContain("[redacted]");
    expect(readFileSync(join(root, "service.log"), "utf8")).not.toContain(Buffer.alloc(32, 1).toString("base64"));
  });

  test("local readiness detects lost address, down interfaces, wrong route and stale socket mapping", async () => {
    const root = fixture();
    writeFileSync(join(root, "lxe-agent.conf"), config());
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(root, "utun99.sock"), resolve));
    const probe = () => spawnSync(bash, ["-c", `
source "$1"
ROOT=$2; CONFIG="$ROOT/lxe-agent.conf"; SOCKET_ROOT=$ROOT; NAME="$ROOT/lxe-agent.name"; WG=/usr/bin/true
ifconfig() { cat "$ROOT/interface"; }
route() { cat "$ROOT/route"; }
probe`, "test", script, root], { encoding: "utf8", timeout: 2000 });
    try {
      writeFileSync(join(root, "lxe-agent.name"), "utun99\n");
      writeFileSync(join(root, "interface"), "utun99: flags=8051<UP,POINTOPOINT,RUNNING>\n inet 10.88.0.25 --> 10.88.0.25\n");
      writeFileSync(join(root, "route"), "interface: utun99\n");
      expect(probe().status).toBe(0);
      writeFileSync(join(root, "route"), "interface: en1\n");
      expect(probe().status).not.toBe(0);
      writeFileSync(join(root, "route"), "interface: utun99\n");
      writeFileSync(join(root, "interface"), "utun99: flags=8051<POINTOPOINT>\n inet 10.88.0.25 --> 10.88.0.25\n");
      expect(probe().status).not.toBe(0);
      writeFileSync(join(root, "interface"), "utun99: flags=8051<UP,POINTOPOINT>\n inet 10.88.0.26 --> 10.88.0.26\n");
      expect(probe().status).not.toBe(0);
      writeFileSync(join(root, "interface"), "utun99: flags=8051<UP,POINTOPOINT>\n inet 10.88.0.25 --> 10.88.0.25\n");
      utimesSync(join(root, "lxe-agent.name"), 1, 1);
      expect(probe().status).not.toBe(0);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  test("stop and uninstall disable automatic restarts and preserve other files", () => {
    const root = fixture();
    expect(run(root, install).status).toBe(0);
    writeFileSync(join(root, "other-vpn.conf"), "unrelated");
    expect(run(root, 'maintenance stop').status).toBe(0);
    expect(existsSync(join(root, "loaded"))).toBeFalse();
    expect(existsSync(join(root, "lxe-agent.conf"))).toBeTrue();
    expect(run(root, 'maintenance uninstall').status).toBe(0);
    expect(existsSync(join(root, "lxe-agent.conf"))).toBeFalse();
    expect(existsSync(join(root, "service.plist"))).toBeFalse();
    expect(readFileSync(join(root, "other-vpn.conf"), "utf8")).toBe("unrelated");
    expect(readFileSync(join(root, "events"), "utf8").trim().endsWith("cleanup")).toBeTrue();
    expect(readFileSync(join(root, "events"), "utf8")).toContain("disable");
  });

  test("supervisor requires two failed checks, rebuilds once, and cleans up on termination", async () => {
    const root = fixture();
    const code = `${setup}
start_tunnel() { echo start >> "$ROOT/events"; command sleep 100 9>&- & quick_pid=$!; }
cleanup_tunnel() { echo cleanup >> "$ROOT/events"; if [[ -n "$quick_pid" ]]; then kill "$quick_pid" 2>/dev/null || true; wait "$quick_pid" 2>/dev/null || true; quick_pid=''; fi; }
probe() { [[ ! -f "$ROOT/broken" ]]; }
sleep() { command sleep 0.1; }
supervise`;
    const child = spawn(bash, ["-c", code, "test", script, root], { stdio: "ignore" });
    const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const waitFor = async (condition: () => boolean) => {
      for (let i = 0; i < 100; i++) { if (condition()) return; await Bun.sleep(25); }
      throw new Error("supervisor state timed out");
    };
    try {
      await waitFor(() => existsSync(join(root, "service.log")) && readFileSync(join(root, "service.log"), "utf8").includes("tunnel_ready"));
      const duplicate = run(root, "supervise");
      expect(duplicate.status).not.toBe(0);
      writeFileSync(join(root, "broken"), "");
      await waitFor(() => (readFileSync(join(root, "events"), "utf8").match(/start/g) ?? []).length >= 2);
      rmSync(join(root, "broken"));
      const events = readFileSync(join(root, "service.log"), "utf8");
      expect(events).toContain("consecutive=1");
      expect(events).toContain("consecutive=2");
    } finally { child.kill("SIGTERM"); await done; }
    expect(run(root, "/usr/bin/lockf -k -s -t 0 \"$ROOT/supervisor.lock\" /usr/bin/true").status).toBe(0);
    expect(readFileSync(join(root, "service.log"), "utf8")).toContain("supervisor_exit code=143");
  });
});
