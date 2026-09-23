# Zhihui TMS Desktop Progress and Artifact Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose truthful, credential-free Zhihui TMS export progress through the existing CLI JSONL stream and verify the Desktop-facing command's page/merged/partial artifacts with fake responses.

**Architecture:** Keep the existing `lxeskill` catalog command and generic `exec` process route. Add optional progress callbacks to the export and XLSX delivery services, then have the CLI adapter implement `run_with_events` and emit only stage names and counts. Reuse the existing flushed CLI JSONL `progress` records and terminal `result`; do not route business commands through the unrelated one-shot runtime probe.

**Tech Stack:** Python 3.12, uv, pytest, existing Bun process route.

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-philippines-design.md`

## Global Constraints

- No live TMS calls, new credentials, or new API requests in tests.
- No Token, Cookie, password, account, product ID, or download URL in progress records.
- Do not change request pacing, retry, or hard limits.
- Preserve actual redacted errors and existing partial page artifact behavior.
- Do not run `git add` or `git commit` until the user explicitly approves the exact files and message.

---

### Task 1: Emit accurate service progress

**Files:**
- Modify: `python/lxeskill_cli/services/zhihui_tms/product_export.py`
- Modify: `python/lxeskill_cli/services/zhihui_tms/xlsx_delivery.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_product_export.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_xlsx_delivery.py`

**Interfaces:**
- `export_stockwarehouse_pages(..., on_event: Callable[[dict[str, Any]], None] | None = None)` reports validated page listing and completed export requests.
- `deliver_product_exports(..., on_event: Callable[[dict[str, Any]], None] | None = None)` reports each saved page and completed merge.

- [x] Write tests asserting event order/counts and no export event on failed export or unsafe page.
- [x] Run those tests and confirm the intended red failure.
- [x] Add optional callbacks at the validated list, successful export, persisted page, and completed merge boundaries. Use only static stages plus page/record counts.
- [x] Run the two focused test modules.

### Task 2: Connect the catalog CLI and verify Desktop-facing envelope

**Files:**
- Modify: `python/lxeskill_cli/services/agent_cli/zhihui/export_products.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_acceptance.py`
- Document: `docs/superpowers/handoffs/2026-09-17-zhihui-tms-desktop-progress.md`

**Interfaces:**
- `run_with_events(arguments: dict[str, Any], on_event: Callable[[dict[str, Any]], None]) -> dict[str, Any]` reuses `run` internals and emits safe login/export/download/merge progress.
- The `lxeskill` command outputs flushed `progress` JSONL records followed by exactly one `result`; `files` remains the authoritative deliverable list.

- [x] Add CLI tests for preview/disabled/busy paths (no misleading progress), success event order, and partial failure with existing page files.
- [x] Run those tests and confirm the intended red failure.
- [x] Implement `run_with_events`, preserving `run` compatibility and redacted exception handling.
- [x] Run `uv run pytest python/lxeskill_cli/tests/zhihui_tms -q` from repository root; inspect exit code and count.
- [x] Inspect `git diff --check` and `git status --short`; report results without staging or committing.

### Task 3: Review existing runtime/desktop delivery route

**Files:**
- Inspect: `packages/agent/runtime/src/tooling/coding/process-manager.ts`
- Inspect: `packages/agent/runtime/src/engine/runtime.ts`
- Inspect: `apps/gateway/src/orchestration/local-conversation.ts`
- Inspect: existing runtime and Desktop artifact tests

- [x] Verify that the generic `exec` command can expose incremental JSONL to the model and existing send-files flow persists multiple artifacts.
- [x] If Desktop still needs direct automatic progress events, document the exact missing seam and request approval before broadening the process protocol; do not claim that Python JSONL alone provides visual Desktop progress.
- [ ] Ask the user to approve exact files and commit message before any `git add` or `git commit`.
