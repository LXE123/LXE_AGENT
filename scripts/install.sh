#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint for historical raw URLs. The source-installed
# product now lives exclusively on lxe-agent-TUI; desktop main has no CLI.
REPO_URL="https://github.com/LXE123/LXE_AGENT.git"
REF="lxe-agent-TUI"
arguments=("$@")

index=0
while [[ $index -lt ${#arguments[@]} ]]; do
  case "${arguments[$index]}" in
    --repo-url)
      index=$((index + 1))
      REPO_URL="${arguments[$index]:?--repo-url requires a value}"
      ;;
    --ref)
      index=$((index + 1))
      REF="${arguments[$index]:?--ref requires a value}"
      ;;
  esac
  index=$((index + 1))
done

if [[ "$REF" == "main" ]]; then
  echo "The main branch is desktop-only. Use --ref lxe-agent-TUI for source installation." >&2
  exit 2
fi

repository="${REPO_URL%.git}"
repository="${repository#git@github.com:}"
repository="${repository#https://github.com/}"
if [[ "$repository" != */* ]]; then
  echo "Unsupported GitHub repository URL: $REPO_URL" >&2
  exit 2
fi

temporary="$(mktemp "${TMPDIR:-/tmp}/lxe-tui-install.XXXXXX.sh")"
trap 'rm -f "$temporary"' EXIT
curl -fsSL "https://raw.githubusercontent.com/${repository}/${REF}/scripts/install.sh" -o "$temporary"
bash "$temporary" "${arguments[@]}"
