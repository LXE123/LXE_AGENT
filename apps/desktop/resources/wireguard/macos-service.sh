#!/opt/homebrew/bin/bash
# Root-owned, fixed-scope controller. No HTTP probes or credential output.
set -Eeuo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL=C
umask 077
ROOT='/Library/Application Support/LXE/WireGuard'
LABEL=com.lxe.wireguard.lxe-agent
PLIST=/Library/LaunchDaemons/com.lxe.wireguard.lxe-agent.plist
CONFIG="$ROOT/lxe-agent.conf"
SERVICE="$ROOT/service.sh"
LOG="$ROOT/service.log"
SOCKET_ROOT=/var/run/wireguard
NAME="$SOCKET_ROOT/lxe-agent.name"
BASH_BIN=/opt/homebrew/bin/bash
WG_QUICK=/opt/homebrew/bin/wg-quick
WG=/opt/homebrew/bin/wg
quick_pid=''
transaction=0
backup=''
had_loaded=0
had_legacy=0
had_disabled=0
changed=0

log_event() {
  local message size=0
  # Redact before truncating: partial secrets must not escape at the boundary.
  message=$(printf '%s' "$*" | sed -E 's/[A-Za-z0-9+\/=]{43,}/[redacted-key]/g; s/(PrivateKey|PresharedKey)[[:space:]]*=.*/\1 = [redacted]/g' | cut -c 1-2000)
  # One writer at a time, including wg-quick's diagnostic stream.
  exec 7>> "$ROOT/log.lock"
  /usr/bin/lockf -s -t 5 7 || { exec 7>&-; return 1; }
  [[ ! -f "$LOG" ]] || size=$(stat -f %z "$LOG")
  if (( size + ${#message} + 64 >= 5242880 )); then
    rm -f "$LOG.3"
    [[ ! -f "$LOG.2" ]] || mv "$LOG.2" "$LOG.3"
    [[ ! -f "$LOG.1" ]] || mv "$LOG.1" "$LOG.2"
    [[ ! -f "$LOG" ]] || mv "$LOG" "$LOG.1"
  fi
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$message" >> "$LOG"
  exec 7>&-
}
log_stream() { while IFS= read -r line; do log_event "upstream $line"; done; }

interface_name() {
  [[ -f "$NAME" && ! -L "$NAME" ]] || return 1
  IFS= read -r interface < "$NAME" || true
  [[ "$interface" =~ ^utun[0-9]+$ ]] || return 1
  if [[ -S "$SOCKET_ROOT/$interface.sock" ]]; then
    local delta
    delta=$(( $(stat -f %m "$SOCKET_ROOT/$interface.sock") - $(stat -f %m "$NAME") ))
    # Match wg-quick: an old .name file must not select a reused utun socket.
    (( delta > -2 && delta < 2 )) || return 1
  fi
  printf '%s\n' "$interface"
}
probe() {
  local interface address
  interface=$(interface_name) || return 1
  [[ -S "$SOCKET_ROOT/$interface.sock" ]] || return 1
  "$WG" show "$interface" public-key >/dev/null 2>&1 || return 1
  address=$(awk '$1 == "Address" {split($3,a,"/"); print a[1]}' "$CONFIG")
  [[ -n "$address" ]] || return 1
  ifconfig "$interface" | awk -v ip="$address" 'NR == 1 && /<UP[,>]/ {up=1} $1 == "inet" && $2 == ip {found=1} END {exit !(up && found)}' || return 1
  route -n get 10.88.0.1 2>/dev/null | awk -v dev="$interface" '$1 == "interface:" && $2 == dev {found=1} END {exit !found}'
}

# Commands that can wait on IPC have a deadline; never block recovery forever.
bounded() {
  local seconds=$1 pid timer rc=0
  shift
  "$@" 9>&- 8>&- & pid=$!
  (sleep "$seconds"; kill -TERM "$pid" 2>/dev/null || true; sleep 1; kill -KILL "$pid" 2>/dev/null || true) 9>&- 8>&- & timer=$!
  wait "$pid" || rc=$?
  kill "$timer" 2>/dev/null || true
  wait "$timer" 2>/dev/null || true
  return "$rc"
}
cleanup_tunnel() {
  local interface
  # Never enumerate/kill other WireGuard processes or touch other .name files.
  if [[ -n "$quick_pid" ]]; then
    kill -TERM -- "-$quick_pid" 2>/dev/null || true
    local i
    for ((i=0; i<10; i++)); do
      kill -0 "$quick_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$quick_pid" 2>/dev/null || true
    local code=0
    wait "$quick_pid" 2>/dev/null || code=$?
    log_event "wg_quick_exit code=$code"
    quick_pid=''
  fi
  if [[ -f "$CONFIG" ]]; then
    bounded 5 "$BASH_BIN" "$WG_QUICK" down "$CONFIG" > >(exec 9>&- 8>&-; log_stream) 2>&1 || true
  fi
  interface=$(interface_name) || interface=''
  [[ -z "$interface" ]] || rm -f "$SOCKET_ROOT/$interface.sock"
  rm -f "$NAME"
}
start_tunnel() {
  log_event 'tunnel_start'
  # Job control gives only this wg-quick and its monitor a separate process group.
  set -m
  "$BASH_BIN" "$WG_QUICK" up "$CONFIG" > >(exec 9>&- 8>&-; log_stream) 2>&1 9>&- 8>&- & quick_pid=$!
}
finish_supervisor() {
  local rc=$?
  trap - EXIT TERM INT
  log_event "supervisor_exit code=$rc"
  cleanup_tunnel
  exec 9>&-
  exit "$rc"
}
supervise() {
  exec 9>> "$ROOT/supervisor.lock"
  /usr/bin/lockf -s -t 0 9 || { exec 9>&-; log_event 'supervisor_already_running'; return 1; }
  trap finish_supervisor EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  local misses=0 recovering=$SECONDS
  log_event "supervisor_start pid=$$"
  cleanup_tunnel
  start_tunnel
  while sleep 5 9>&-; do
    if kill -0 "$quick_pid" 2>/dev/null && bounded 2 probe; then
      misses=0
      if (( recovering >= 0 )); then
        log_event "tunnel_ready recovery_seconds=$((SECONDS - recovering))"
        recovering=-1
      fi
    else
      misses=$((misses + 1))
      log_event "tunnel_check_failed consecutive=$misses"
      if (( misses >= 2 )); then
        recovering=$SECONDS
        cleanup_tunnel
        start_tunnel
        misses=0
      fi
    fi
  done
}

write_plist() {
  cat > "$PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.lxe.wireguard.lxe-agent</string>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/bash</string><string>/Library/Application Support/LXE/WireGuard/service.sh</string><string>supervise</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
PLIST
  chown root:wheel "$PLIST"
  chmod 0644 "$PLIST"
  plutil -lint "$PLIST" >/dev/null
}
stop_service() {
  if launchctl print "system/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "system/$LABEL"
  fi
  # Wait for cleanup to release its kernel lock. Stale files/PID reuse cannot block us.
  /usr/bin/lockf -k -s -t 15 "$ROOT/supervisor.lock" /usr/bin/true
}
start_service() {
  launchctl enable "system/$LABEL"
  launchctl bootstrap system "$PLIST"
  local deadline=$((SECONDS + 25))
  while (( SECONDS < deadline )); do
    if launchctl print "system/$LABEL" >/dev/null 2>&1 && bounded 2 probe; then return 0; fi
    sleep 1
  done
  log_event 'service_readiness_timeout'
  return 1
}
validate_config() {
  # Only the serialized enrollment format is accepted, never wg-quick hooks.
  awk '
    {sub(/\r$/, "")}
    /^$/ {next}
    /^\[Interface\]$/ {next}
    /^\[Peer\]$/ {next}
    /^PrivateKey = [A-Za-z0-9+\/=]+$/ {key++; next}
    /^PublicKey = [A-Za-z0-9+\/=]+$/ {pub++; next}
    /^Address = 10\.88\.0\.[0-9]+\/32$/ {addr++; next}
    /^AllowedIPs = 10\.88\.0\.1\/32$/ {ips++; next}
    /^Endpoint = [A-Za-z0-9.-]+:51820$/ {endpoint++; next}
    /^PersistentKeepalive = 25$/ {keep++; next}
    {bad=1}
    END {exit (bad || key!=1 || pub!=1 || addr!=1 || ips!=1 || endpoint!=1 || keep!=1)}
  ' "$1"
}
finish_install() {
  local rc=$? restored=1
  trap - EXIT TERM INT
  set +e
  if (( transaction && rc != 0 && changed )); then
    log_event "install_failed code=$rc rollback_start"
    if ! stop_service; then
      # Do not overwrite files or tear down interfaces while an old owner is alive.
      restored=0
      log_event 'rollback_stop_failed'
    else
      cleanup_tunnel
      if [[ -f "$backup/config" ]]; then cp "$backup/config" "$CONFIG" || restored=0; else rm -f "$CONFIG" || restored=0; fi
      if [[ -f "$backup/service" ]]; then cp "$backup/service" "$SERVICE" || restored=0; fi
      if [[ -f "$backup/plist" ]]; then cp "$backup/plist" "$PLIST" || restored=0; else rm -f "$PLIST" || restored=0; fi
      if (( restored && had_loaded )); then
        start_service || restored=0
      elif (( restored && had_legacy )); then
        # Migrate the old configuration to supervision even on failed replacement.
        cp "$backup/legacy" "$CONFIG" && write_plist && start_service || restored=0
      fi
      if (( ! had_loaded && ! had_legacy )); then
        [[ -f "$backup/service" ]] || rm -f "$SERVICE"
      fi
      if (( had_disabled )); then launchctl disable "system/$LABEL" || restored=0; fi
    fi
    log_event "rollback_finished restored=$restored"
  fi
  [[ -z "$backup" ]] || rm -rf "$backup"
  exec 8>&-
  if (( rc != 0 )); then
    [[ ! -f "$LOG" ]] || tail -n 12 "$LOG" >&2
    printf 'LXE_WG_PREVIOUS_REMOVED=%s\n' "$((1 - restored))"; fi
  exit "$rc"
}
install_service() {
  local target=$1 previous=$2 source_script=$3
  [[ -f "$target" && ! -L "$target" && -f "$source_script" && ! -L "$source_script" ]] || return 1
  validate_config "$target"
  [[ -z "$previous" ]] || validate_config "$previous"
  exec 8>> "$ROOT/install.lock"
  /usr/bin/lockf -s -t 0 8 || { exec 8>&-; echo 'WireGuard installation already in progress' >&2; return 1; }
  trap finish_install EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  backup=$(mktemp -d "$ROOT/.rollback.XXXXXX")
  [[ ! -f "$CONFIG" ]] || cp "$CONFIG" "$backup/config"
  [[ ! -f "$SERVICE" ]] || cp "$SERVICE" "$backup/service"
  [[ ! -f "$PLIST" ]] || cp "$PLIST" "$backup/plist"
  if launchctl print "system/$LABEL" >/dev/null 2>&1; then had_loaded=1; fi
  if launchctl print-disabled system | grep -Eq '"com[.]lxe[.]wireguard[.]lxe-agent"[[:space:]]*=>[[:space:]]*true'; then had_disabled=1; fi
  if interface_name >/dev/null; then
    had_legacy=1
    cp "${previous:-$target}" "$backup/legacy"
  fi
  # Snapshot all user-owned input before changing a running tunnel.
  cp "$target" "$backup/new-config"
  cp "$source_script" "$backup/new-service"
  validate_config "$backup/new-config"
  transaction=1
  changed=1
  stop_service
  cleanup_tunnel
  install -o root -g wheel -m 0600 "$backup/new-config" "$CONFIG"
  install -o root -g wheel -m 0700 "$backup/new-service" "$SERVICE"
  write_plist
  start_service
  log_event 'install_completed local_tunnel_ready'
  transaction=0
}
maintenance() {
  exec 8>> "$ROOT/install.lock"
  /usr/bin/lockf -s -t 0 8 || return 1
  trap 'exec 8>&-' EXIT
  launchctl disable "system/$LABEL"
  stop_service
  cleanup_tunnel
  log_event "maintenance_$1"
  if [[ "$1" == uninstall ]]; then rm -f "$PLIST" "$CONFIG" "$SERVICE"; fi
}
main() {
  [[ $EUID == 0 ]] || { echo 'Run this controller with administrator privileges' >&2; return 1; }
  # Reject redirected managed paths before executing/writing as root.
  local path
  for path in '/Library/Application Support/LXE' "$ROOT" "$CONFIG" "$SERVICE" "$PLIST" "$LOG"; do
    [[ ! -L "$path" ]] || { echo 'Refusing a symlink in managed WireGuard paths' >&2; return 1; }
  done
  mkdir -p "$ROOT"
  chown root:wheel "/Library/Application Support/LXE"
  chmod 0755 "/Library/Application Support/LXE"
  chown root:wheel "$ROOT"
  chmod 0700 "$ROOT"
  case "${1:-}" in
    install) [[ $# == 4 ]]; install_service "$2" "$3" "$4" ;;
    supervise) supervise ;;
    probe) probe ;;
    stop|uninstall) maintenance "$1" ;;
    *) echo 'Usage: service.sh {install TARGET PREVIOUS SOURCE | supervise | probe | stop | uninstall}' >&2; return 2 ;;
  esac
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
