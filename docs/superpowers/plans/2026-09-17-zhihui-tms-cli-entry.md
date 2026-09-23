# Zhihui TMS CLI Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Register one truthful, previewable CLI capability for the Philippines product export, with execution gated by runtime credentials and an explicit production switch.

**Architecture:** A pure intent normalizer and planner define the fixed export contract. A single business CLI adapter consumes the plan, checks the execution gate before constructing an HTTP Client, then composes login, bounded pagination, and XLSX delivery. Catalog and Skill describe this one capability; Desktop secret injection follows in phase 6.

**Tech Stack:** Python, pytest, JSON Catalog, Bun contract tests.

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-philippines-design.md`

## Global Constraints

- The four documented natural-language report phrases all map to the same full product export; no historical report is claimed.
- The CLI accepts no account/password/token arguments. Execution requires `ZHIHUI_TMS_ACCOUNT`, `ZHIHUI_TMS_PASSWORD`, and `ZHIHUI_TMS_PRODUCTION_ENABLED=1` in the process environment.
- Preview has no network or output-file side effects. `action=execute` is explicit.
- Each execution writes into its own artifact subdirectory. Partial page files may be returned on failure; a failed merge is never reported as successful.
- Only one export may run per artifact workspace at a time; another process receives an immediate busy result before login.
- The existing Client pacing, bounded retries and hard pagination limits remain active.
- Do not use live credentials or call the production API in tests. Do not push the worktree branch.

---

### Task 1: Define deterministic intent and plan

**Files:** `python/lxeskill_cli/services/zhihui_tms/intent.py`, `planner.py`, `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`.

- [x] Test that supported language returns one Philippines product export and records that report wording is not a historical metric.
- [x] Test that preview planning validates action and fixes page size, limits, date label, and warehouse scope.
- [x] Implement pure normalizer and planner; run focused tests.

### Task 2: Compose the guarded CLI adapter

**Files:** `python/lxeskill_cli/services/agent_cli/zhihui/export_products.py`, `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`.

- [x] Test preview uses no credentials or network, and execute fails closed before Client creation when the gate or secrets are missing.
- [x] Test an injected fake Client end-to-end through login, pagination, delivery and artifact metadata; test partial failure paths.
- [x] Implement `run(arguments)` with only Catalog fields in its input, read secrets from environment, use a unique artifact output directory, and return truthful redacted results.
- [x] Run focused tests.

### Task 3: Register and verify the command contract

**Files:** `python/lxeskill_cli/lxeskill/catalog.json`, `python/lxeskill_cli/lxeskill/business.py`, `skills/zhihui-tms-product-export/SKILL.md`, matching Python and Bun contract tests.

- [x] Register one command, `lxeskill tms philippines products-export`, owned by one Skill, with no secret argument fields.
- [x] Add the module naming rule and explicit artifact path selectors; update affected catalog counts and Bun expectation.
- [x] Run Python `tests/lxeskill` plus `tests/infra`, Bun `lxeskill-command.test.ts`, and focused Zhihui tests.
- [x] Inspect the exact staged files and commit this core capability to the current branch without push.
