# Zhihui TMS XLS/XLSX Download and Merge Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Download each TMS export safely, normalize validated XLS/XLSX source files into dated page workbooks, merge them in page order with one header, and return truthful `artifacts[]` metadata.

**Architecture:** Extend the synchronous Zhihui TMS Client with a bounded binary download method that validates HTTPS, trusted host, redirect behavior, response size, MIME, and file signature before any file is written. Add a focused workbook delivery service that parses XLS/XLSX with the project's existing spreadsheet libraries, validates a single header row and consistent headers across pages, writes page outputs and a merged workbook atomically, and retains page files when merge fails.

**Tech Stack:** Python 3.12, `requests`, `openpyxl`, `xlrd`, pytest fake HTTP responses and temporary workbooks.

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-philippines-design.md`

## Global Constraints

- Download URLs must be HTTPS and restricted to the trusted TMS export host `tms-cos.mabangerp.com` by default.
- Redirects are disabled; a redirect or untrusted host stops the task before writing output.
- Accept only XLS/XLSX file signatures, appropriate spreadsheet MIME values, and bounded file sizes.
- Output names use one `YYYYMMDD` label: `智汇tms-商品-第N页-YYYYMMDD.xlsx` and `智汇tms-商品-合并-YYYYMMDD.xlsx`.
- Every page workbook and the merged workbook is a separate `artifacts[]` item; no duplicate paths and no merged artifact after merge failure.
- Page order and exactly one header row are preserved; headers must match across all pages.
- Tests use generated non-production workbook bytes and fake HTTP; no live TMS or production credentials.

---

### Task 1: Add safe binary download to the Client

**Files:**
- Modify: `python/lxeskill_cli/services/zhihui_tms/client.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_client.py`

**Interfaces:**
- `ZhihuiTmsClient.download_bytes(url, *, allowed_hosts=("tms-cos.mabangerp.com",), max_bytes=50_000_000, operation="智汇 TMS 文件下载") -> tuple[bytes, str]`.

- [x] Write failing tests for HTTPS/host validation, redirect refusal, MIME/signature validation, max-size refusal, timeout, and bounded retry.
- [x] Run the focused download tests and verify they fail before implementation.
- [x] Implement binary download validation with the existing Client timeout/retry policy and truthful redacted errors.
- [x] Run the focused download tests and verify they pass.

### Task 2: Implement workbook normalization, validation, merge, and artifacts

**Files:**
- Create: `python/lxeskill_cli/services/zhihui_tms/xlsx_delivery.py`
- Modify: `python/lxeskill_cli/services/zhihui_tms/__init__.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_xlsx_delivery.py`

**Interfaces:**
- `ZhihuiTmsArtifact(path, kind, page, total_pages)`, where `kind` is `page` or `merged`.
- `ZhihuiTmsDeliveryResult(artifacts, page_artifacts, merged_artifact, headers, total_rows)`.
- `deliver_product_exports(client, export_result, *, output_dir, date_label) -> ZhihuiTmsDeliveryResult`.

- [x] Write failing tests for XLS and XLSX source parsing, consistent headers, page naming, merged ordering, one header, empty pages, duplicate artifact prevention, and merge failure retaining page files without a merged artifact.
- [x] Run the focused workbook tests and verify they fail before implementation.
- [x] Implement bounded workbook parsing and atomic page/merge writes with explicit cleanup only for incomplete temporary files.
- [x] Run the focused workbook tests and verify they pass.

### Task 3: Document and verify the phase handoff

**Files:**
- Create: `docs/superpowers/handoffs/2026-09-17-zhihui-tms-xlsx-delivery.md`

- [x] Record download security, workbook behavior, artifact contract, tests, risks, and the remaining Skill/Desktop boundary.
- [x] Run `uv run pytest python/lxeskill_cli/tests/zhihui_tms -q` from the repository root and confirm a non-empty passing collection.
- [x] Run `git diff --check`, inspect staged files, and commit only phase 4 files with `feat: add Zhihui TMS xlsx delivery`.
