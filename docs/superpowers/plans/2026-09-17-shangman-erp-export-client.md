# Wisdom Indonesia ERP Export Client Implementation Plan

**Goal:** Build a testable Python client that authenticates to the Wisdom Indonesia ERP, submits the goods export, downloads a validated XLSX, and returns canonical artifact metadata.

**Architecture:** Keep platform HTTP/auth concerns in `services/shangman/goods_export.py`, with an injectable captcha-code provider and injectable aiohttp-compatible session. Validate workbook bytes before exposing the artifact, scan actual worksheet rows instead of trusting worksheet dimensions, and keep output under the existing artifact root without changing Skill, Catalog, or Desktop contracts in this phase.

**Tech Stack:** Python 3.12, aiohttp, openpyxl, pytest, existing `shared.workspace` artifact root.

**Spec:** User-provided Wisdom Indonesia ERP API contract and `docs/handoff/CURRENT_HANDOFF.md` deliverable requirements.

## Global Constraints

- Credentials and captcha text are supplied by the runtime/caller; no credentials, tokens, or captcha bypass/OCR are stored or logged.
- Only trusted `https` download URLs are accepted; the default allowlist contains the exact hosts `erp.shangmanet.com` and `oss.erp.shangmanet.com`.
- The client does not implement production gates, Desktop settings, Skill, Catalog, natural-language routing, or real ERP integration tests.
- Downloaded files use `智慧印尼-商品-YYYYMMDD-HHMMSS.xlsx` and retain the source workbook bytes.
- Errors preserve observed status/business/parse details after redaction and truncation.

### Task 1: Define the client contract and failing tests

**Files:**
- Create: `python/lxeskill_cli/services/shangman/__init__.py`
- Create: `python/lxeskill_cli/services/shangman/goods_export.py`
- Create: `python/lxeskill_cli/tests/shangman/test_goods_export.py`

- [x] Add tests for captcha retrieval, login query/header/auth construction, successful export/download, canonical metadata, and exact filename format.
- [x] Add tests for invalid export responses, untrusted/non-HTTPS URLs, malformed XLSX, missing business headers, bilingual source headers, and inaccurate dimensions.
- [x] Run the focused test file and confirm the new tests fail for the missing implementation.

### Task 2: Implement authentication and export/download flow

**Files:**
- Modify: `python/lxeskill_cli/services/shangman/goods_export.py`
- Modify: `python/lxeskill_cli/services/shangman/__init__.py`

- [x] Implement an injectable captcha provider protocol and caller-supplied static provider.
- [x] Implement the captcha GET, captcha-code login POST, export POST, trusted URL validation, and XLSX download using an injectable session.
- [x] Add redacted, bounded error types for HTTP, authentication, business, URL, and workbook failures.
- [x] Write bytes atomically enough for validation to run before the final artifact is returned, and clean invalid partial files.
- [x] Run the focused tests and inspect the request assertions and returned payload.

### Task 3: Document handoff and verify the phase

**Files:**
- Create: `docs/handoff/CURRENT_HANDOFF.md`

- [x] Record the branch, completed files, deferred Skill/Catalog/Desktop/captcha-input work, risks, and exact verification command/results.
- [x] Run `uv run pytest python/lxeskill_cli/tests/shangman/test_goods_export.py` from the repository root.
- [x] Run `git diff --check` and confirm only phase files are changed before the user-authorized commit step.
