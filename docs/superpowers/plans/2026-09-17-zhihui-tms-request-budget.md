# Zhihui TMS Request Budget and Account Lock Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bound every physical TMS HTTP attempt, including retries and downloads, and serialize export tasks for the same account across Desktop workspaces.

**Architecture:** Count attempts at the Client's only HTTP send boundary. Derive an account-specific lock filename from a one-way hash, using Desktop's shared data root when available and the local artifact root otherwise. Keep the lock around login through delivery.

**Tech Stack:** Python, pytest, existing interprocess lock.

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-philippines-design.md`

## Global Constraints

- Default physical HTTP attempt budget is 400 across login, list, export and download.
- The budget is checked before `session.request`, and retries consume it.
- Account identifiers and passwords never appear in lock filenames or error text.
- A second task for the same account must fail before login; a different account can hold a different lock.
- No real TMS requests, production credentials, push or pool upload.

---

### Task 1: Count Client HTTP attempts

**Files:** `python/lxeskill_cli/services/zhihui_tms/client.py`, `python/lxeskill_cli/tests/zhihui_tms/test_client.py`.

- [x] Test a low attempt budget across separate methods and retries; the next attempt must fail before the fake Session sees it.
- [x] Add constructor validation, counter, and a budget check at the shared pacing boundary.
- [x] Run Zhihui tests from the repository root.

### Task 2: Lock by account across Desktop workspaces

**Files:** `python/lxeskill_cli/services/agent_cli/zhihui/export_products.py`, `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`.

- [x] Test that two workspaces with the same account and shared `LXE_DATA_ROOT` resolve the same lock, while distinct accounts do not.
- [x] Hash account identifiers and keep the lock in the shared data root; retain a local fallback for standalone CLI use.
- [x] Run focused tests and inspect sensitive output.

### Task 3: Verify and commit

- [x] Run focused Python tests and exact diff checks.
- [x] Commit the safety change only to the current development branch without push.
