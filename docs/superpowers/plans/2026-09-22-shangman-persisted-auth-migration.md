# Shangman Persisted Authentication Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the feature's per-run captcha/broker authentication with upstream's persisted Shangman authentication while retaining the feature's fixed goods-export Contract and production gate.

**Architecture:** Import upstream's account-scoped `Credentials`, `AuthStore`, login workflow, and token-reading exporter as the sole authentication implementation. Keep the feature adapter as the business boundary: it validates fixed parameters, enforces the production gate, emits compact terminal projection, and delegates export to the persisted-auth implementation. The login Skill is only a recovery prerequisite with a single caller-side re-export limit.

**Tech Stack:** Python 3.12, aiohttp, Bun/TypeScript catalog tooling, pytest.

**Spec:** `docs/superpowers/specs/2026-09-22-shangman-persisted-auth-migration-design.md`

## Global Constraints

- `LXE_SHANGMAN_PROD_ENABLED` remains required before token reads or ERP requests.
- Do not modify Runtime Step Loop, `lxeskill/business.py`, other platform Contracts, or ERP retry/risk controls.
- No automatic login/export loop: 401 invalidation never retries in Python. One completed login and at most one recovered export is enforced by the Skill/Agent Contract, not new cross-turn Runtime state.
- Do not commit or push.

### Task 1: Land the upstream persisted-auth foundation

**Files:**
- Replace: `python/lxeskill_cli/services/shangman/auth.py`, `state.py`, `goods_export.py`
- Add: `python/lxeskill_cli/services/shangman/workflow.py`, `services/agent_cli/shangman/login_{prepare,submit,status,clear}.py`
- Test: `python/lxeskill_cli/tests/shangman/test_login.py`, `test_goods_export.py`

- [x] Add failing tests proving missing or expired persisted state returns `login_required` before any HTTP call, and 401 invalidates only the rejected token.
- [x] Import the upstream auth/state/exporter implementation without changing its no-retry HTTP semantics.
- [x] Run `uv run pytest python/lxeskill_cli/tests/shangman/test_login.py python/lxeskill_cli/tests/shangman/test_goods_export.py -q`.

### Task 2: Preserve the feature business boundary

**Files:**
- Modify: `python/lxeskill_cli/services/agent_cli/shangman/_workflow.py`, `goods_export_run.py`, `goods_export_preview.py`
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`, `skills/shangman-goods-export-workflow-map/SKILL.md`
- Test: `python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py`, `python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`

- [x] Add failing tests for gate-before-exporter, valid persisted token direct delivery, `login_required` compact terminal output, and fixed parameters.
- [x] Keep preview/run structured Contract and projection; enforce production gate before delegate invocation and map upstream results to the existing compact envelope.
- [x] Add login command catalog entries and skill documentation as recovery-only capability; document one recovery attempt at the caller boundary.
- [x] Run focused workflow and catalog tests.

### Task 3: Remove the conflicting interactive authentication stack

**Files:**
- Delete: `python/lxeskill_cli/services/shangman/captcha_channel.py`
- Delete: `packages/agent/runtime/src/tooling/pending-sensitive-input.ts`, its test, and Dashboard pending-input UI/RPC only if no other command declares the capability
- Modify: Runtime catalog loader/host/UI/protocol only to remove now-unused generic capability plumbing

- [x] Search catalog first; no command declares `pending_sensitive_input` for Shangman.
- [x] Remove Shangman runtime requirement and all old channel tests.
- [x] Verify no source occurrence of the retired broker/channel/challenge strings remains.

### Task 4: Verify and document

- [x] Run persisted-auth, feature Contract, four-platform terminal, TypeScript typecheck, and `git diff --check` suites.
- [x] Confirm source scans have no old broker or `captcha_channel` paths; inspect `git status` for unrelated user files.
- [x] Update handoff with exact test results and no-commit status.
