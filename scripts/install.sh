#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/LXE123/LXE_AGENT.git"
REF="main"
INSTALL_DIR=""
NO_PATH=0
PYTHON_VERSION="3.12.10"
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

node_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1)'
}

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
  fi
}

ensure_node() {
  if node_supported && command -v npm >/dev/null 2>&1; then
    echo "Using Node.js $(node --version)"
    echo "Using npm $(npm --version)"
    return
  fi

  load_nvm
  if ! command -v nvm >/dev/null 2>&1; then
    echo "nvm not found. Installing nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    load_nvm
  fi
  if ! command -v nvm >/dev/null 2>&1; then
    echo "nvm installation finished, but nvm is still unavailable." >&2
    exit 1
  fi

  nvm install --lts
  nvm use --lts

  if ! node_supported || ! command -v npm >/dev/null 2>&1; then
    echo "Node.js 20.19+, 22.12+, or 23+ with npm is required for Dashboard UI." >&2
    exit 1
  fi
  echo "Using Node.js $(node --version)"
  echo "Using npm $(npm --version)"
}

build_dashboard() {
  local project_root="$1"
  local dashboard_dir="$project_root/web/agent-dashboard"
  [[ -f "$dashboard_dir/package.json" ]] || { echo "Dashboard package.json missing: $dashboard_dir" >&2; exit 1; }
  [[ -f "$dashboard_dir/package-lock.json" ]] || { echo "Dashboard package-lock.json missing: $dashboard_dir" >&2; exit 1; }

  ensure_node
  (
    cd "$dashboard_dir"
    npm ci
    npm run build
  )
  [[ -f "$dashboard_dir/dist/index.html" ]] || { echo "Dashboard UI build did not produce dist/index.html" >&2; exit 1; }
}

write_launcher() {
  local project_root="$1"
  local uv_path="$2"
  mkdir -p "$LAUNCHER_DIR"
  cat > "$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
LXE_ROOT="$project_root"

case "\${1:-}" in
  start)
    cd "\$LXE_ROOT"
    "$uv_path" run --frozen python ./main.py
    ;;
  *)
    echo "Usage: LXE <start>" >&2
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
write_launcher "$project_root" "$uv_path"
add_launcher_path

echo "Install completed."
echo "Start the agent with: LXE start"
