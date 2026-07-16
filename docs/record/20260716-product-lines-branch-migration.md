# Product lines and branch migration

Status: Accepted (2026-07-16)

## Decision

- `main` is the default Electron desktop product line. It owns Electron Main,
  the React renderer, the private `agent-cli`, managed runtimes, and Windows NSIS packaging.
- `lxe-agent-TUI` is the source-installed Gateway/TUI product line. It owns the
  terminal launchers, browser Dashboard installation flow, and project `.venv` runtime.
- The branches remain independent product histories. Shared fixes are moved
  selectively; the branches are not kept synchronized by merge or rebase.

Both branches retain `scripts/install.sh` and `scripts/install.ps1`, but their
default source ref is always `lxe-agent-TUI`. This keeps historical raw URLs under
`main` safe after the desktop branch becomes the default: invoking an old installer
still installs the source product rather than a desktop source tree.

## Existing source installations

An installation that still tracks the former `main` must retarget once after the
GitHub branch rename:

```bash
git fetch origin
git branch -m main lxe-agent-TUI
git branch --set-upstream-to=origin/lxe-agent-TUI lxe-agent-TUI
git remote set-head origin -a
```

After that migration, `LXE update` continues to update the source product. Raw
installer URLs and existing local upstream configuration do not follow a GitHub
branch rename automatically.

## Local worktrees

- `/Users/llxx/Projects/github/LXE_AGENT_LOCAL_FBA` tracks desktop `main`.
- `/Users/llxx/Projects/github/LXE_AGENT_LOCAL_FBA-TUI` tracks `lxe-agent-TUI`.

The primary workspace path is unchanged. No Codex or Claude Code session storage
is modified as part of the branch or linked-worktree rename.
