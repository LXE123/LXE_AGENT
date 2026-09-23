# Zhihui TMS Product Pagination and Per-Page Export Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe product-list pagination and one batch export request per non-empty page on top of the phase 2 synchronous Zhihui TMS Client.

**Architecture:** Keep platform HTTP details in `ZhihuiTmsClient` and put pagination state, hard limits, duplicate detection, and per-page export orchestration in a focused service module. The service returns ordered in-memory page results containing the original export response and `pop`; it does not download or rewrite files yet.

**Tech Stack:** Python 3.12, `requests`, dataclasses, pytest fake clients.

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-philippines-design.md`

## Global Constraints

- Product list requests always use `pageSize=1000`.
- Stop only when `datas` is empty, accumulated records reach `totalNum`, or the current page has fewer than 1000 records; do not rely only on `pop.totalPage`.
- Export only non-empty pages and preserve each page's original `pop` response for the next download phase.
- Enforce `max_pages`, `max_records`, `max_requests`, and `max_runtime` before the next external request.
- Reject duplicate product IDs, inconsistent `totalNum`, invalid IDs, non-advancing response page numbers, and missing export `pop` instead of guessing.
- Use fake clients and fixtures; do not call TMS or use production credentials.

---

### Task 1: Add endpoint methods to the phase 2 Client

**Files:**
- Modify: `python/lxeskill_cli/services/zhihui_tms/client.py`
- Modify: `python/lxeskill_cli/services/zhihui_tms/__init__.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_client.py`

- [x] Write failing tests for the exact list payload (`page`, `pageSize=1000`, and documented filters) and export payload (`idsList` and documented export options).
- [x] Run the endpoint tests and verify they fail because the methods do not exist.
- [x] Implement `find_my_stockwarehouse_list(page)` and `export_stockwarehouse(product_ids)` using `post_json`.
- [x] Run the focused endpoint tests and verify they pass.

### Task 2: Implement bounded pagination and per-page export

**Files:**
- Create: `python/lxeskill_cli/services/zhihui_tms/product_export.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_product_export.py`

**Interfaces:**
- `ZhihuiTmsExportPage(page, product_ids, response)` stores one ordered exported page and exposes `pop`.
- `ZhihuiTmsExportResult(pages, total_records, reported_total_num, request_count)` stores the complete in-memory export plan/result.
- `export_stockwarehouse_pages(client, *, max_pages=100, max_records=100_000, max_requests=200, max_runtime=900.0, clock=time.monotonic)` performs bounded synchronous list/export calls.

- [x] Write failing tests for total-count stopping, short-page stopping, empty-page success, duplicate IDs, changing totals, invalid IDs, non-advancing pages, missing `pop`, and all four hard limits.
- [x] Run the focused pagination tests and verify they fail before implementation.
- [x] Implement the state machine with checks before each list/export request and truthful sanitized diagnostics from the Client errors.
- [x] Run the focused pagination tests and verify they pass.

### Task 3: Document and verify the phase handoff

**Files:**
- Create: `docs/superpowers/handoffs/2026-09-17-zhihui-tms-product-pagination.md`

- [x] Record scope, endpoint contracts, stopping rules, safety behavior, tests, risks, and the next phase boundary (download/XLSX remains unimplemented).
- [x] Run `uv run pytest python/lxeskill_cli/tests/zhihui_tms -q` from the repository root and confirm a non-empty passing collection.
- [ ] Run `git diff --check`, inspect the staged file list, and commit only phase 3 files with `feat: add Zhihui TMS product pagination`.
