#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/LXE123/LXE_AGENT.git"
REF="main"
INSTALL_DIR=""
NO_PATH=0
PYTHON_VERSION="3.12.10"
BUN_VERSION="1.3.14"
PROJECT_NAME="lxe-agent"
LAUNCHER_DIR="$HOME/.lxe/bin"
LAUNCHER_PATH="$LAUNCHER_DIR/LXE"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url)
      REPO_URL="${2:?--repo-url requires a value}"
      shift 2
      ;;
    --ref)
      REF="${2:?--ref requires a value}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:?--install-dir requires a value}"
      shift 2
      ;;
    --no-path)
      NO_PATH=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

resolve_full_path() {
  local target="$1"
  case "$target" in
    "~")
      target="$HOME"
      ;;
    "~/"*)
      target="$HOME/${target#~/}"
      ;;
  esac
  if [[ "$target" = /* ]]; then
    printf '%s\n' "$target"
  else
    printf '%s\n' "$(pwd)/$target"
  fi
}

test_lxe_project_root() {
  local path="$1"
  [[ -f "$path/package.json" ]] || return 1
  [[ -f "$path/bun.lock" ]] || return 1
  [[ -f "$path/pyproject.toml" ]] || return 1
  [[ -f "$path/uv.lock" ]] || return 1
  grep -Eq 'name[[:space:]]*=[[:space:]]*"lxe-agent"' "$path/pyproject.toml"
}

resolve_uv() {
  if command -v uv >/dev/null 2>&1; then
    command -v uv
    return
  fi
  if [[ -x "$HOME/.local/bin/uv" ]]; then
    export PATH="$HOME/.local/bin:$PATH"
    printf '%s\n' "$HOME/.local/bin/uv"
    return
  fi

  echo "uv not found. Installing uv with the official installer..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v uv >/dev/null 2>&1; then
    echo "uv installation finished, but uv is still not available on PATH." >&2
    exit 1
  fi
  command -v uv
}

ensure_python() {
  local uv_path="$1"
  "$uv_path" python install "$PYTHON_VERSION" || {
    echo "uv python install failed. Checking whether Python $PYTHON_VERSION is already usable..."
    "$uv_path" run --python "$PYTHON_VERSION" --no-sync python -c "import sys; assert sys.version.startswith('$PYTHON_VERSION'), sys.version; print(sys.version)"
  }
}

zip_url() {
  local trimmed="${REPO_URL%/}"
  trimmed="${trimmed%.git}"
  printf '%s/archive/refs/heads/%s.zip\n' "$trimmed" "$REF"
}

download_source_zip() {
  local destination="$1"
  local temp_root
  temp_root="$(mktemp -d "${TMPDIR:-/tmp}/lxe-agent.XXXXXX")"
  local zip_path="$temp_root/source.zip"
  local extract_root="$temp_root/extract"
  mkdir -p "$extract_root"
  trap 'rm -rf "$temp_root"' EXIT

  curl -L "$(zip_url)" -o "$zip_path"
  unzip -q "$zip_path" -d "$extract_root"
  local source_dir
  source_dir="$(find "$extract_root" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$source_dir" ]]; then
    echo "Downloaded zip did not contain a source directory." >&2
    exit 1
  fi
  mv "$source_dir" "$destination"
  rm -rf "$temp_root"
  trap - EXIT
}

get_project_root() {
  local target="$INSTALL_DIR"
  if [[ -z "$target" ]]; then
    target="$HOME/.lxe_agent"
  fi
  target="$(resolve_full_path "$target")"
  if [[ -e "$target" ]]; then
    echo "Install directory already exists: $target. Delete it manually and run again." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$target")"

  if command -v git >/dev/null 2>&1; then
    echo "Cloning $REPO_URL ($REF) to $target..."
    git clone --branch "$REF" --single-branch "$REPO_URL" "$target"
  else
    echo "git not found. Downloading source zip..."
    download_source_zip "$target"
  fi

  if ! test_lxe_project_root "$target"; then
    echo "Downloaded source is not a valid $PROJECT_NAME project: $target" >&2
    exit 1
  fi
  printf '%s\n' "$target"
}

load_bun_path() {
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

bun_supported() {
  command -v bun >/dev/null 2>&1 || return 1
  [[ "$(bun --version)" == "$BUN_VERSION" ]]
}

ensure_bun() {
  load_bun_path
  if bun_supported; then
    echo "Using Bun $(bun --version)"
    return
  fi

  echo "Bun $BUN_VERSION is not available. Installing the pinned version..."
  curl -fsSL https://bun.sh/install | bash -s -- "bun-v$BUN_VERSION"
  load_bun_path
  if ! bun_supported; then
    echo "Bun installation finished, but Bun $BUN_VERSION is not available." >&2
    exit 1
  fi
  echo "Using Bun $(bun --version)"
}

build_dashboard() {
  local project_root="$1"
  local dashboard_dir="$project_root/web/agent-dashboard"
  [[ -f "$project_root/package.json" ]] || { echo "Root package.json missing: $project_root" >&2; exit 1; }
  [[ -f "$project_root/bun.lock" ]] || { echo "Root bun.lock missing: $project_root" >&2; exit 1; }
  [[ -f "$dashboard_dir/package.json" ]] || { echo "Dashboard package.json missing: $dashboard_dir" >&2; exit 1; }

  ensure_bun
  (
    cd "$project_root"
    bun install --frozen-lockfile
    bun run dashboard:build
  )
  [[ -f "$dashboard_dir/dist/index.html" ]] || { echo "Dashboard UI build did not produce dist/index.html" >&2; exit 1; }
}

write_launcher() {
  local project_root="$1"
  local bun_path="$2"
  mkdir -p "$LAUNCHER_DIR"
  cat > "$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
LXE_ROOT="$project_root"

case "\${1:-}" in
  start)
    cd "\$LXE_ROOT"
    "$bun_path" run gateway:start
    ;;
  stop)
    cd "\$LXE_ROOT"
    "$bun_path" run gateway:stop
    ;;
  *)
    echo "Usage: LXE <start|stop>" >&2
    exit 2
    ;;
esac
EOF
  chmod +x "$LAUNCHER_PATH"
}

add_launcher_path() {
  if [[ "$NO_PATH" -eq 1 ]]; then
    echo "Skipping PATH update because --no-path was provided."
    return
  fi
  case ":$PATH:" in
    *":$LAUNCHER_DIR:"*) return ;;
  esac
  local shell_rc="$HOME/.zshrc"
  if [[ "${SHELL:-}" == */bash ]]; then
    shell_rc="$HOME/.bashrc"
  fi
  mkdir -p "$(dirname "$shell_rc")"
  if [[ ! -f "$shell_rc" ]] || ! grep -Fq "$LAUNCHER_DIR" "$shell_rc"; then
    printf '\nexport PATH="%s:$PATH"\n' "$LAUNCHER_DIR" >> "$shell_rc"
  fi
  export PATH="$LAUNCHER_DIR:$PATH"
}

uv_path="$(resolve_uv)"
project_root="$(get_project_root)"
cd "$project_root"

echo "Using uv: $uv_path"
echo "Project root: $project_root"

ensure_python "$uv_path"

"$uv_path" sync --frozen --all-groups --python "$PYTHON_VERSION"
"$uv_path" run --frozen python -m playwright install chromium
build_dashboard "$project_root"
bun_path="$(command -v bun)"
write_launcher "$project_root" "$bun_path"
add_launcher_path

echo "Install completed."
echo "Start the agent with: LXE start"
