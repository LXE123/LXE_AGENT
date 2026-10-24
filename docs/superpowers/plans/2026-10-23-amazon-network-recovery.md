# Amazon network recovery Implementation Plan

> **For agentic workers:** Execute inline using the existing diagnosis and verification workflow. No delegated agents are needed.

**Goal:** Diagnose the five captured 2026-10-23 connection failures and repair only confirmed HTTP stop-boundary defects.

**Architecture:** Preserve existing direct-network clients, authentication, CLI results and logging. Isolate historical fixes on `codex/amazon-network-recovery` (pool-10), based on main `abde37dd`; PR4 remains unchanged.

**Tech Stack:** Python, uv/pytest, aiohttp, Bun.

**Spec:** User request in this conversation, “Amazon 备货真实运行异常诊断与最小优化”, 2026-10-23.

## Global constraints

- No production ERP requests, authentication refreshes or file sends during investigation.
- No new client, framework, global retry manager, Skill, dependency or lock-file changes.
- Preserve 401 recovery; HTTP 403/429 stop. Keep connection retries bounded and do not raise attempt counts.
- Historical network-layer causes without captured DNS/TCP/TLS evidence remain UNKNOWN.
- Original diagnosis authorization excluded publication; the user explicitly authorized Commit, normal Push and a separate PR on 2026-10-24. No PR4 source changes or worktree reset.

## Task 1: Evidence and ownership

- [x] Correlate the six original PR4 transcripts with runtime-py and Desktop logs; record exact timestamps, source line references, actual errors and subsequent outcomes in `docs/record/20261023-amazon-network-recovery.md`.
- [x] Trace the existing ERP/EXTERNAL sessions, cloud client, finite retries, authentication refreshes, task creation, output publication and session cleanup. Inspect tool schema and temporary spreadsheet scripts; do not infer absent network observations.

## Task 2: Store resolver stop boundary

Files: `python/lxeskill_cli/services/mabang/amazon/fba/store_resolver.py`, existing `tests/mabang/test_mabang_fba_store_resolver.py`.

- [x] Add tests through `fetch_fba_stores()` using existing response/session fixtures: 403 and 429 each make one request and zero refreshes; 401 refreshes once, repeated 401 stops; connector exception remains the original object; an HTTP-200 challenge page fails parsing without refreshing.
- [x] Run the new selection before production edits and confirm 403 fails.
- [x] Change only `AUTH_FAIL_STATUS = {401, 403}` to `{401}`; HTTP 403 follows existing `MabangRequestError` path with status and body.

## Task 3: Official query rate-limit boundary

Files: `python/lxeskill_cli/services/mabang/official_api.py`, existing `tests/mabang/test_mabang_official_combo.py`.

- [x] Add a 429 followed by success fixture and require one request, no sleep and preserved actual 429 diagnostic; confirm red before the fix.
- [x] Remove 429 from the existing retryable-status tuple. Preserve connection and 502/503/504 retry budget.
- [x] Change the existing recovery fixture from 429/503/success to 502/503/success; require waits `[1, 2]` and three requests.

## Task 4: Verification and handoff

- [x] Run affected store/official/SKU, CLI, authentication and network-client pytest suites from pool-10 root; use only fixtures and localhost.
- [x] Run existing Runtime tool-contract and Desktop cloud-context tests; distinguish model input failures from schema defects.
- [x] Check protected PR4 HEAD, clean worktree, pool-10 diff, lockfile equality and `git diff --check`; write red/green counts, evidence limits and remaining historical risks to the record.
- [x] Leave all changes unstaged for independent review.

First-phase result: two production files and three existing test files changed. New regression selection was red (4 failed / 6 passed); Python 234 passed and Bun 58 passed. The three remaining 403 consumers were initially documented as unchanged, then explicitly authorized for Task 5. Network subcauses remain UNKNOWN; no production replay or Git publication.


## Task 5: Authorized MSKU / Shenzhen / shipment 403 follow-up

User explicitly authorized continuing these three historical paths on the same independent branch, with no commit or push.

- [x] Preserve the seven existing changed paths and PR4 HEAD before editing; add only the three response classifiers and their existing consumer tests.
- [x] Add pipeline tests injecting actual HTTP responses at MSKU ID/export, Shenzhen search/export and shipment shop/status boundaries. Require HTTP403 to make one attempt, zero refreshes and no publication; require HTTP401 to refresh once and remain bounded on repeated rejection.
- [x] Exercise shipment HTTP200 JSON code401/403 in integer and text form, including the shared single-delivery CSV consumer; keep downstream export/download work from starting after rejection.
- [x] Confirm the new regressions fail before changing production. Change the three `AUTH_FAIL_STATUS` constants to `{401}`, and narrow batch-delivery JSON authentication classification to code401.
- [x] Reuse prior fixtures; change old synthetic AuthError403 recovery tests to AuthError401. Do not add string parsing at retry boundaries, new clients or broader retry policies.
- [x] Run affected Python suites and full local handoff regression, check exact diff / unstaged state / protected PR4, then update the diagnostic record with new evidence and remaining UNKNOWN network causes.

Task 5 result: 52 new parametrized cases, red 26 failed / 26 passed; four-file green 120 passed; final 21-file regression 345 passed (29 existing aiohttp warnings). Three additional production files changed by four classification lines. Earlier five source/test edits preserved byte-for-byte; cumulative 14 paths remain unstaged. PR4 stays clean at b892ea8f. Bun 58-pass evidence reused because its source and tests are unchanged; no real ERP, authentication, Desktop or Windows validation claimed.

## Publication closeout (2026-10-24 authorization)

- [x] Recheck the exact patch and current main; preserve all other worktree drafts.
- [x] Rerun affected Python and Bun regressions; record actual results and sandbox failures in the existing diagnostic handoff.
- [ ] Stage only the 14 reviewed paths, commit and verify clean state, then normal push and create the independent network PR. No merge or production calls.
