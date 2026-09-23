# Zhihui TMS Client and Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a fixture-tested Zhihui TMS HTTP client that performs password login, retains the authenticated Session and apiToken in memory, validates response schemas, applies bounded retries and timeouts, and exposes only redacted truthful errors.

**Architecture:** Add a focused `services/zhihui_tms` adapter. `ZhihuiTmsClient` owns the `requests.Session`, authentication state, request headers, timeout and retry policy; schema helpers validate only the response shapes needed by phase 2; error helpers preserve observed HTTP/business/transport/schema details after redaction and explicit truncation. No pagination, export, XLSX, Skill, Catalog, or Desktop integration is included.

**Tech Stack:** Python 3.12, `requests`, dataclasses, pytest fixtures.

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-philippines-design.md`

## Global Constraints

- Base endpoint is `https://tms.mabangerp.com/tmsapi` unless explicitly overridden by a test or non-production configuration.
- Login sends `userName`, `pwd`, and `local_time`; it does not invent a pre-login token or cookie.
- Successful login requires HTTP 200, string `code == "200"`, and non-empty string `data.apiToken`.
- Requests have an explicit connect/read timeout and at most three attempts by default.
- Retries are limited to 408, 429, 500, 502, 503, 504, and transient connection/timeout failures; authentication, permission, schema, and business errors stop immediately.
- Passwords, tokens, cookies, and credential-like fields never appear in logs, exception text, fixtures, or committed source.
- Tests use fake responses and no production credentials or live external requests.

---

### Task 1: Define error redaction and response schemas

**Files:**
- Create: `python/lxeskill_cli/services/zhihui_tms/errors.py`
- Create: `python/lxeskill_cli/services/zhihui_tms/schemas.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_schemas.py`

**Interfaces:**
- Produces `ZhihuiTmsError`, `ZhihuiTmsConfigError`, `ZhihuiTmsTransportError`, `ZhihuiTmsHttpError`, `ZhihuiTmsApiError`, and `ZhihuiTmsSchemaError` with safe `message`, `code`, `http_status`, and sanitized `payload` fields.
- Produces `LoginResult(api_token, user_id, supplier_id, customer_id, role_id)` and `parse_login_response(payload, http_status=200)`.

- [x] Write failing tests for valid login parsing, missing/empty `apiToken`, wrong business code, non-object JSON, and redaction/truncation of password, token, cookie, and long observed messages.
- [x] Run `uv run pytest python/lxeskill_cli/tests/zhihui_tms/test_schemas.py -q` and verify the new tests fail because the module does not exist.
- [x] Implement bounded recursive redaction and strict login schema parsing while preserving the observed non-secret message and response shape.
- [x] Run the focused schema tests and verify they pass.

### Task 2: Implement Session client, login, timeout, and bounded retry

**Files:**
- Create: `python/lxeskill_cli/services/zhihui_tms/client.py`
- Create: `python/lxeskill_cli/services/zhihui_tms/__init__.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_client.py`
- Create: `python/lxeskill_cli/tests/zhihui_tms/fixtures/login_success.json`
- Create: `python/lxeskill_cli/tests/zhihui_tms/fixtures/business_error.json`

**Interfaces:**
- Produces `RetryPolicy(max_attempts=3, backoff_seconds=1.0, jitter_ratio=0.25)`.
- Produces `ZhihuiTmsClient(base_url=..., session=..., timeout=(5.0, 30.0), retry_policy=..., sleeper=..., random_fn=...)`.
- `ZhihuiTmsClient.login(username, password, *, local_time=None) -> LoginResult` sends the documented login body, stores apiToken in memory, and preserves Session cookies.
- `ZhihuiTmsClient.post_json(path, payload, *, operation) -> dict[str, Any]` sends authenticated JSON requests with explicit timeout and validates a JSON object response.

- [x] Write failing tests for exact login payload/headers/timeout, session cookie retention, token injection after login, retryable 503/429 and transport failures, non-retryable 401/403, and truthful redacted errors.
- [x] Run the focused client tests and verify they fail before implementation.
- [x] Implement the request loop with `requests.Session.request`, retry-after support, exponential backoff plus injectable jitter/sleep, and no retry on authentication/permission/schema/business failures.
- [x] Implement login state transition only after schema validation; never log credentials or return raw response objects.
- [x] Run the focused client tests and verify they pass.

### Task 3: Add stage handoff documentation and final focused verification

**Files:**
- Create: `docs/superpowers/handoffs/2026-09-17-zhihui-tms-client-auth.md`

- [x] Record scope, files, decisions, test commands/results, known risks, and the next phase boundary (pagination and export remain unimplemented).
- [x] Run `uv run pytest python/lxeskill_cli/tests/zhihui_tms -q` from the repository root and confirm a non-empty test collection and real passing output.
- [x] Inspect `git diff --check`, `git status`, and the final diff for credentials, production calls, and out-of-scope changes.
- [x] Commit only the stage 2 files with `feat: add Zhihui TMS client authentication`.
