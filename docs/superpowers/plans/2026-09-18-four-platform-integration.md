# Four Platform Integration Implementation Plan

> **For agentic workers:** Execute inline with review checkpoints. Preserve all four source branches and their existing worktrees.

**Goal:** Make the Zhihui TMS, Shangman Wisdom, Yacang, and Mabang Brazil export workflows available from one desktop/runtime checkout without losing any source branch's behavior.

**Architecture:** Keep platform-specific implementations from their source branches. Merge shared Desktop settings/protocol, dashboard navigation, runtime environment, Skill catalog, and ownership as unions, retaining schema migration compatibility. Resolve overlaps in a separate integration checkout, never in pool worktrees.

**Tech Stack:** Bun, TypeScript, Python 3.12 via uv, Electron Desktop, lxeskill CLI.

**Spec:** `docs/handoff/2026-09-18-pool-123-integration.md` plus the pool-4 handoffs in `docs/handoff/2026-09-18-mabang-brazil-overseas-*.md`; the user explicitly extended the scope to all four platforms.

## Global Constraints

- Source commits: pool-2 `9ea85b1d`, pool-3 `e1f73fe0`, pool-4 `cb7fc1dc`, full Zhihui `5323c7bf`; retain the pool-1 `ae72dc65` ancestor already in integration.
- Preserve the existing pool worktrees, local secrets, and source branches.
- Use `uv --frozen` and Bun for verification. Do not call live third-party APIs during merge verification.
- Do not merge into `main` or push without a separate explicit decision.

## Task 1: Incorporate pool-4

**Files:** `python/lxeskill_cli/lxeskill/catalog.json`, `python/lxeskill_cli/lxeskill/business.py`, `config/skill-labels.json`, platform-specific `python/lxeskill_cli/services/mabang/brazil_overseas/`, `skills/replenishment-brazil-overseas-export/`, associated tests and handoffs.

- [x] Fetch `codex/mabang-brazil-overseas-export` from the local source repository into the integration checkout.
- [x] Merge it while preserving the existing Shangman/Yacang catalog entries and Skill ownership.
- [x] Run `uv run --frozen pytest -q python/lxeskill_cli/tests/mabang python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra` and `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`.
- [x] Review the staged diff for lost commands, then commit this integration step (`55fb98e7`).

## Task 2: Incorporate complete Zhihui

**Files:** `apps/desktop/src/main/config-store/`, `apps/dashboard/src/desktop/`, `apps/dashboard/src/shared/i18n.tsx`, `apps/agent-cli/src/runtime-host.ts`, `apps/gateway/src/bootstrap/env.ts`, `packages/foundation/desktop-protocol/src/index.ts`, `python/lxeskill_cli/lxeskill/catalog.json`, corresponding tests.

- [x] Fetch `codex/zhihui-tms-client-auth` at the exact source commit and merge it into the integration branch.
- [x] Resolve shared fields by retaining Zhihui, Shangman, and Yacang config/secrets/IPC fields; retain Mabang's existing authentication and Brazil export routing.
- [x] Check the four public CLI commands by catalog name and path, plus Desktop runtime environment propagation.
- [x] Run the changed Python platform, catalog, and Desktop/Bun tests; fix integration failures at their source, then commit this integration step.

## Task 3: Final validation and handoff

**Files:** `docs/handoff/2026-09-18-four-platform-integration.md` and any tests needed to lock the four-way contract.

- [x] Run `bun run typecheck`, the relevant Bun suites, Python platform suites, and `bun run dashboard:build` from the integration checkout.
- [ ] Check `git diff --check`, `git status`, missing command/Skill labels, secret-bearing diffs, and the four source commits' ancestry.
- [ ] Document exact commit, entry paths, environment variables, tests, limits, and next step; register the verified branch in the original repository without altering any pool worktree.
