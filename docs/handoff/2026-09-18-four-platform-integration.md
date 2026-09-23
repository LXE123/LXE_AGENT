# Four-platform integration handoff

## Checkout and provenance

- Branch/Pool: `codex/integrate-pool-123` in the separate integration checkout; despite its historical branch name, this merge includes pool 4. Do not develop in `main` or edit the four source worktrees.
- Parent source commits: Zhihui `5323c7bf` (pool 1 full workflow), Shangman `9ea85b1d` (pool 2), Yacang `e1f73fe0` (pool 3), Mabang Brazil `cb7fc1dc` (pool 4). The earlier pool-1 ancestor `ae72dc65` is retained. Pool-4 integration commit: `55fb98e7`.
- Integration merge commit: see `git log -1 --format=%h`; this document is created as part of that commit.

## What runs where

One Desktop/Agent runtime discovers all four owner Skills and the common `lxeskill` command catalog. The workflows are separate commands, not one command that executes all four exports together:

| Platform | Owner Skill | CLI entry | Desktop configuration |
| --- | --- | --- | --- |
| Zhihui TMS, Philippines | `zhihui-tms-product-export` | `lxeskill tms philippines products-export` | Zhihui account/password plus explicit production enablement |
| Shangman Wisdom, Indonesia | `shangman-goods-export-workflow-map` | `lxeskill shangman export preview` / `lxeskill shangman export run` | Shangman tenant/user/processed password and production setting |
| Yacang | `yacang-export-workflow-map` | `lxeskill yacang export run` | Yacang mobile/password and production setting |
| Mabang Brazil overseas | `replenishment-brazil-overseas-export` | `lxeskill replenish brazil-overseas export` | Existing Mabang account/password; no separate pool-4 Desktop credential panel |

Shared integration files include `python/lxeskill_cli/lxeskill/catalog.json`, `python/lxeskill_cli/lxeskill/business.py`, `packages/agent/runtime/test/tooling/lxeskill-command.test.ts`, `apps/desktop/src/main/config-store/{model,secrets,setup,validation}.ts`, `packages/foundation/desktop-protocol/src/index.ts`, `apps/dashboard/src/desktop/settings-model.ts`, `apps/dashboard/src/desktop/shell.tsx`, `apps/dashboard/src/shared/i18n.tsx`, and `apps/gateway/src/bootstrap/env.ts`. Platform-specific Python services and Skill manifests remain isolated.

## Credential and runtime contract

- Desktop stores integration secrets through its existing encrypted secret repository. The runtime receives `ZHIHUI_TMS_ACCOUNT`, `ZHIHUI_TMS_PASSWORD`, `ZHIHUI_TMS_PRODUCTION_ENABLED`; `LXE_SHANGMAN_TENANT_ID`, `LXE_SHANGMAN_USERNAME`, `LXE_SHANGMAN_PROCESSED_PASSWORD`, `LXE_SHANGMAN_BASIC_AUTH`, `LXE_SHANGMAN_PROD_ENABLED`; `LXE_YACANG_MOBILE`, `LXE_YACANG_PASSWORD`, `LXE_YACANG_PROD_ENABLED`; and `MABANG_ACCOUNT`, `MABANG_PASSWORD` when respective integrations are configured.
- A single save can configure all four; saving only one subsequently leaves the other three intact. A restart restores all four in `apps/desktop/test/config-store.test.ts`. The Skill catalog preserves all four routing entries in `packages/agent/runtime/test/tooling/lxeskill-command.test.ts`.
- The Zhihui Python test file was renamed to `test_zhihui_client.py` to avoid Pytest's default import collision with Yacang's `test_client.py` when all platforms are tested together.

## Verification and limits

- Python related suites: 1645 passed, 1 skipped. Full Python suite: 2226 passed, 2 skipped, 54 subtests passed.
- TypeScript typecheck, protocol check, production boundary check, Dashboard production build, and changed Bun suites passed (126 tests before adding the final all-four configuration regression).
- A full Bun run in the restricted sandbox produced 1626 passed, 4 skipped, 21 failed. Socket/HTTP tests passed when rerun outside the sandbox. The original checkout's pinned `fd 10.5.0` passed 87 search/coding tests when supplied as `LXE_FD_PATH` without modifying the source worktrees. A stale integration schema assertion was corrected and passed on rerun. Two failures remain in unrelated pre-existing test/code mismatches: `apps/desktop/test/development-launcher.test.ts` expects `process.execPath` but the unchanged Desktop dev launcher uses `"bun"`; `apps/dashboard/test/appearance.test.ts` expects no `12px` font sizes but the previous checkout already contains two Yacang test-page selectors using them. These are not recorded as passing. No live third-party platform login/export was performed: real credentials, permissions, network responses, and production datasets still require a controlled smoke test.
- No `main` merge or `push` is implied by this handoff. The next operator should verify against the newest `main`, run necessary environment-dependent checks, then request a separate decision before merging or pushing.
