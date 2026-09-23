# Zhihui TMS Request Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep TMS authentication, listing, export and download requests sequential and bounded, without repeating requests that may create an export.

**Architecture:** Put request pacing and retry eligibility in the existing synchronous Client, where all HTTP attempts are sent. Keep export orchestration and business intent unchanged. Use fake sessions and clocks to verify the number and order of attempts; no live account calls.

**Tech Stack:** Python, requests, pytest.

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-philippines-design.md`

## Global Constraints

- A 429 response is a stop signal for this run, including downloads.
- Login and export generation are sent once; a timeout or server error must keep the observed failure rather than assume it is safe to repeat.
- Read-only listing and binary download may retry only transient failures, with existing bounded exponential backoff.
- A minimum interval applies before every HTTP attempt, including retries, with no parallel requests.
- No real TMS request or production credential is used in tests.

---

### Task 1: Verify request safety rules

**Files:** `python/lxeskill_cli/tests/zhihui_tms/test_client.py`

**Interfaces:** `ZhihuiTmsClient(..., min_request_interval_seconds=2.0, clock=time.monotonic)`.

- [x] Test that a 429 listing response stops after one attempt and retains the HTTP response error.
- [x] Test that login and export generation do not retry after a transient HTTP status or timeout.
- [x] Test that listing retries remain bounded and each attempt is paced; download 429 stops.
- [x] Run the focused tests and observe failures before implementation.

### Task 2: Implement Client pacing and retry selection

**Files:** `python/lxeskill_cli/services/zhihui_tms/client.py`

**Interfaces:** `_pace_request()` before every `session.request`; retry only `findMyStockwarehouseList` and safe downloads on transient failures other than 429.

- [x] Add the interval and clock constructor inputs, validate them, and pace every HTTP attempt.
- [x] Restrict POST retries to the read-only list operation; stop immediately on 429.
- [x] Stop downloads immediately on 429 while preserving bounded retries for other transient statuses.
- [x] Run all Zhihui TMS tests from the repository root.

### Task 3: Review and commit this core change

**Files:** This plan, the Client, and the Client tests.

- [x] Check the diff and ensure only these files are staged.
- [x] Commit with an English conventional message on the current task branch; do not push.
