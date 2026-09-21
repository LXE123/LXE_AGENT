"""Token-free HTTP transport to the configured LXE server.

No business rules, permission cache, retries, desktop state or network bootstrap.
HTTP failures are responses; only connection failures raise CloudConnectionError.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
from http.client import HTTPException
import math
import os
import re
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_RESPONSE_BYTES = 1024 * 1024
MAX_DIAGNOSTIC_CHARS = 4000
TIMEOUT_SECONDS = 15
SENSITIVE = re.compile(r"authorization|cookie|password|secret|token|api.?key", re.I)


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def redact(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if SENSITIVE.search(str(key)) else redact(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if not isinstance(value, str):
        return value
    for name, secret in os.environ.items():
        if SENSITIVE.search(name) and len(secret) >= 6:
            value = value.replace(secret, "[REDACTED]")
    value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
    value = re.sub(r"\blxe_(?:client|identity|dev|run|erp_run|session|erp_session|handoff|erp_handoff)_[A-Za-z0-9._-]+", "[REDACTED]", value)
    return re.sub(r'''(?i)((?:authorization|cookie|password|secret|token|api[_-]?key)["']?\s*[:=]\s*)["']?[^\s,;}"']+''', r"\1[REDACTED]", value)


def diagnostic(value, truncated=False):
    safe = redact(value)
    text = safe if isinstance(safe, str) else json.dumps(safe, ensure_ascii=False)
    if len(text) > MAX_DIAGNOSTIC_CHARS:
        text = text[:MAX_DIAGNOSTIC_CHARS]
        truncated = True
    if truncated:
        text += " ... [truncated]"
    return text


def normalize_server_url(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("Set LXE_DATA_SERVER_URL or pass --server")
    url = urlsplit(value)
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username is not None
            or url.password is not None or url.path not in {"", "/"} or url.query or url.fragment
            or any(c.isspace() for c in value)):
        raise ValueError("Server must be an HTTP(S) origin without credentials, path, query or fragment")
    try:
        url.port
    except ValueError:
        raise ValueError("Server port is invalid") from None
    return value.rstrip("/")


def _validate_path(path: str) -> None:
    # Validate decoded forms too, so a proxy cannot reinterpret an encoded target.
    candidate = path
    for _ in range(len(path) + 1):
        if (not candidate.startswith("/") or "//" in candidate or "\\" in candidate
                or "?" in candidate or "#" in candidate
                or any(ord(c) <= 32 or ord(c) == 127 for c in candidate)
                or any(part in {".", ".."} for part in candidate.split("/"))):
            raise ValueError("Cloud request must use a server-relative path without query, fragment or traversal")
        decoded = unquote(candidate)
        if decoded == candidate:
            return
        candidate = decoded
    raise ValueError("Invalid cloud request path")


@dataclass(frozen=True)
class CloudResponse:
    status_code: int
    elapsed_ms: int
    payload: Any
    json_valid: bool
    truncated: bool
    headers: dict[str, str] = field(default_factory=dict)
    content: bytes = b""

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")

    def json(self) -> Any:
        if not self.json_valid:
            raise ValueError("Response is not valid JSON")
        return self.payload


class CloudConnectionError(RuntimeError):
    def __init__(self, cause: Exception, elapsed_ms: int, http_status: int | None = None, *, retryable: bool = False):
        super().__init__(diagnostic(f"{type(cause).__name__}: {cause}"))
        self.elapsed_ms = elapsed_ms
        self.retryable = retryable
        self.http_status = http_status


class CloudClient:
    def __init__(self, server_url: str, *, timeout: float = TIMEOUT_SECONDS,
                 max_response_bytes: int | None = MAX_RESPONSE_BYTES):
        self.server_url = normalize_server_url(server_url)
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Cloud timeout must be positive and finite")
        if max_response_bytes is not None and (not isinstance(max_response_bytes, int) or isinstance(max_response_bytes, bool) or max_response_bytes <= 0):
            raise ValueError("Cloud response limit must be a positive integer")
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self._opener = build_opener(ProxyHandler({}), _NoRedirects())

    @classmethod
    def from_env(cls, *, server_url: str | None = None, **options) -> CloudClient:
        value = os.getenv("LXE_DATA_SERVER_URL", "") if server_url is None else server_url
        return cls(value, **options)

    def request_json(self, method: str, path: str, *, json_body: Any = None) -> CloudResponse:
        return self._request(method, path, json_body=json_body, accept="application/json")

    def request_bytes(self, method: str, path: str) -> CloudResponse:
        return self._request(method, path, accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, application/json")

    def _request(self, method: str, path: str, *, json_body: Any = None, accept: str) -> CloudResponse:
        """Perform one request; preserve non-JSON bodies and HTTP errors for callers.

        payload is unmodified application data. Use diagnostic/redact at output
        boundaries. A truncated response must never be treated as complete data.
        """
        _validate_path(path)
        method = method.upper()
        if method not in {"GET", "POST"}:
            raise ValueError("Cloud client currently supports GET and POST")
        if method == "GET" and json_body is not None:
            raise ValueError("GET requests cannot contain a JSON body")
        headers = {"X-LXE-Client": "cli", "Accept": accept}
        data = None
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(self.server_url + path, data=data, headers=headers, method=method)
        started = time.monotonic()
        status = None
        try:
            try:
                response = self._opener.open(request, timeout=self.timeout)
            except HTTPError as exc:
                response = exc
            with response:
                status = response.code
                raw = response.read() if self.max_response_bytes is None else response.read(self.max_response_bytes + 1)
                headers = response_headers(getattr(response, "headers", {}))
        except (URLError, OSError, ValueError, HTTPException) as exc:
            elapsed_ms = round((time.monotonic() - started) * 1000)
            raise CloudConnectionError(exc, elapsed_ms, status) from exc
        elapsed_ms = round((time.monotonic() - started) * 1000)
        return parse_response(status, elapsed_ms, raw, self.max_response_bytes, headers)


def response_headers(headers) -> dict[str, str]:
    # Only metadata needed by callers; never propagate cookies/authentication.
    return {key.title(): value for key, value in headers.items()
            if key.lower() in {"content-type", "content-disposition", "retry-after"}}


def parse_response(status: int, elapsed_ms: int, raw: bytes, limit: int | None,
                   headers: dict[str, str]) -> CloudResponse:
    truncated = limit is not None and len(raw) > limit
    content = raw if limit is None else raw[:limit]
    text = content.decode("utf-8", errors="replace")
    try:
        payload = json.loads(text)
        json_valid = True
    except ValueError:
        payload = text
        json_valid = False
    return CloudResponse(status, elapsed_ms, payload, json_valid, truncated, headers, content)
