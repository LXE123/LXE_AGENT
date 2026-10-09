# Four-PR compatibility acceptance implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement each layer and verification-before-completion before reporting results.

**Goal:** Verify the reviewed CLI state repair plus the three original business changes can be delivered as small serial PRs without dropping behavior.

**Architecture:** Keep upstream/main as the common baseline and preserve all original branches. Prepare four explicitly named cumulative acceptance worktrees; while commits are forbidden these are code snapshots, not a committed Git stack. After separately approved commits, create the real parent chain and review PR1 -> PR2 -> PR3 -> PR4 serially.

**Tech Stack:** Git worktree pool, Bun 1.4.2, locked uv/Python 3.12, macOS Seatbelt, existing fixture exporters and workbook tests.

**Spec:** The user's approved four-layer acceptance contract in this conversation; source handoffs for CLI state compatibility and the three business commits.

## Automated acceptance status (2026-10-08)

- All implementation and automated gates below are complete. Read-only incremental patch checks pass for all four predecessor snapshots; no synthetic commits or index writes were used.
- Evidence is saved outside the repository at `/Users/hym/Documents/ChatGPT/项目合并/four-pr-compatibility-evidence-2026-10-08.json`; it is not part of any PR scope.
- The four snapshots shared the baseline HEAD during acceptance. On 2026-10-09 the user separately approved controlled staging/commits, establishing the parent chain and syncing only local origin; verify the resulting real commits and merge-tree before that local push.
- Pool-22 is the active complete combination; pool-18 was stopped during the separately approved service transition. The user reported combination testing passed before the latest migration correction; post-correction production retesting and native Windows validation remain NOT VERIFIED.

## Global constraints

- Locked main: `5f78534174b76461a352bd326aabba33f2942b48`, confirmed with upstream fetch on 2026-10-08.
- Original sources: pool-17 reviewed public repair; TMS `cb07ec4a`; Shangman `e57801e1`; Yacang `06301fff`.
- During acceptance, staging/commits/pushes were forbidden. Delivery authorization on 2026-10-09 allows explicit-path staging, commits and the four new parent-linked branches, then normal push only to local origin. No main/old-branch changes, rebase/reset, force push, GitHub push or online PR creation.
- Each worktree owns its uv-created .venv. Use scripts/wt-claim, never manual worktree creation.
- No production export or login requests. Live validation is performed by the user.
- Preserve workflow/schema/authentication/file-delivery contracts except the already approved Yacang sales deliverable date-column change.
- No platform Runtime conditions, new routing or retry loops, Cloud security changes, Step Loop changes or dependencies.
- Write a per-layer handoff and record incremental scope; no hidden source overlay.
- Windows native ACL and Excel/WPS installer behavior remain NOT VERIFIED on this Mac.

## Layer 1: reviewed generic CLI state repair

Files: reviewed public boundary/path changes from pool-17 plus the approved minimal migration correction in pool-19. CLI-wide startup migration was removed; migration now occurs on actual default DB access and copies only three Python-owned tables. Custom paths/unrelated CLI commands do not scan legacy DBs.

- [x] Apply the reviewed diff with apply_patch to pool-19; record source/destination diff equality.
- [x] Run existing boundary/CLI/bootstrap/SQLite migration tests:
  `bun test packages/agent/runtime/test/permissions/exec-sandbox.test.ts packages/agent/runtime/test/permissions/temporary-resources.test.ts scripts/prepare-exec-sandbox.test.ts packages/agent/runtime/test/tooling/lxeskill-command.test.ts apps/desktop/test/runtime-state.test.ts`
  and `.venv/bin/python -m pytest python/lxeskill_cli/tests/infra/test_sqlite_state_migration.py python/lxeskill_cli/tests/infra/test_relocate_data.py -q`.
- [x] Confirm only registered business child processes gain the three state roots; ordinary/read-only commands and Bun DB remain restricted.

## Layer 2: Mabang TMS country/name routing

Files: the seven files in `git diff --name-only 5f785341 cb07ec4a`. Consume Layer 1 unchanged; produce Philippine-only TMS Skill and its existing regressions.

- [x] Prepare pool-20 from Layer 1's explicit diff and new files.
- [x] Apply the TMS regression assertions first; `bun test packages/agent/runtime/test/tooling/skills.test.ts` must fail on the old country description.
- [x] Apply the remaining TMS diff exactly; the same Bun file plus command tests must pass.
- [x] Verify the Layer 2 incremental diff contains only the original TMS file set.

## Layer 3: Shangman Indonesia routing

Files: Shangman goods/login Skills, shared Southeast Asia Skill, shared skills.test.ts, catalog documentation and Shangman handoff. Consume Layers 1-2 unchanged.

- [x] Preserve the TMS assertions and add the original Shangman assertions; verify the unchanged Shangman description fails `/仅.*印尼/`.
- [x] Fuse three shared files semantically: keep the Shangman Indonesia description (already excludes legacy TMS text), both sets of test assertions, and both country restrictions in the workflow map.
- [x] Keep both TMS/Philippines and Shangman/Indonesia documentation updates.
- [x] Run Skill discovery and catalog regressions and confirm no legacy names remain in model-visible SKILL.md files. Do not infer natural-language model behavior solely from string assertions.

## Layer 4: Yacang sales snapshot-date delivery

Files: the nine files in `git diff --name-only 5f785341 06301fff`. Consume Layers 1-3 unchanged; the only Python overlap is test_export.py, whose new DB path must remain.

- [x] Add original Yacang delivery tests before production files; the date-removal test must fail on the original 16-column output.
- [x] Apply the delivery.py/workflow/catalog/Skill updates. Fuse only the Yacang row of shared catalog/map docs, retaining both country restrictions.
- [x] Run `.venv/bin/python -m pytest python/lxeskill_cli/tests/yacang python/lxeskill_cli/tests/infra python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/mabang_tms python/lxeskill_cli/tests/mabang/test_brazil_export.py python/lxeskill_cli/tests/shangman -q --tb=short`.
- [x] Run targeted Runtime/Gateway/Desktop/Skill Bun, `bun run typecheck` and `bun run desktop:build` on the complete snapshot.
- [x] Confirm XLSX opens with openpyxl, non-worksheet ZIP members and source original are unchanged, partial files survive, other reports/authentication remain unchanged.

## Scope and final gates

- [x] Generate a non-secret JSON evidence manifest: baseline/source hashes, per-layer incremental paths, parent snapshot hashes, tests and explicit unverified items.
- [x] Validate incremental patches in memory: each applies without conflicts to its declared predecessor and reproduces the next layer; no synthetic commits are used.
- [x] Verify `git diff --check`, `git diff --cached --check`, `git ls-files -u`, empty indexes, no sensitive/unrelated files and unchanged original branches.
- [x] After separate authorization, stop only pool-18 and start the explicit pool-22 complete snapshot. This transition is complete; do not restart or interrupt that service during the migration correction.
- [x] Report automated compatibility separately from final live four-platform and Windows acceptance. Do not claim these are complete unless observed.
- [x] Correct the approved migration ownership/trigger defects in Layer 1 and propagate unchanged to Layers 2-4; focused Python 18 passed, combined Python 590 passed / 2 skipped, Bun 58 passed and pool-22 typecheck passed. Consolidate duplicate acceptance reports into the existing per-module handoffs.
- [x] Obtain explicit user approval on 2026-10-09 for controlled four-layer commits/parent-chain establishment and local-origin sync only. GitHub push/online PR creation remain unapproved.
- Delivery gate: before local push, verify exact incremental scopes, actual parents, clean indexes/worktrees and merge-tree. Final commit hashes and push results belong in the external delivery evidence.
