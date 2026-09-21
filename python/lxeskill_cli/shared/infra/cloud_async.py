"""Async native cloud transport, imported only by async business callers."""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any
import aiohttp

from .cloud_client import (
    CloudClient, CloudConnectionError, CloudResponse, _validate_path,
    parse_response, response_headers,
)


class AsyncCloudClient:
    def __init__(self, server_url: str, *, timeout: float = 60, max_response_bytes: int | None = None):
        config = CloudClient(server_url, timeout=timeout, max_response_bytes=max_response_bytes)
        self.server_url = config.server_url
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self._session = None

    async def __aenter__(self):
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout), trust_env=False,
            cookie_jar=aiohttp.DummyCookieJar(),
        )
        return self

    async def __aexit__(self, *args):
        await self._session.close()

    async def request_json(self, method: str, path: str, *, json_body: Any = None) -> CloudResponse:
        _validate_path(path)
        if method not in {"GET", "POST"} or (method == "GET" and json_body is not None):
            raise ValueError("Unsupported cloud request method/body")
        headers = {"X-LXE-Client": "cli", "Accept": "application/json"}
        data = None
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self._session is None or self._session.closed:
            raise RuntimeError("Use AsyncCloudClient as an async context manager")
        started = time.monotonic()
        status = None
        try:
            async with self._session.request(method, self.server_url + path, data=data,
                                            headers=headers, allow_redirects=False) as response:
                status = response.status
                chunks = []
                size = 0
                async for chunk in response.content.iter_chunked(65536):
                    if self.max_response_bytes is not None:
                        chunk = chunk[:max(0, self.max_response_bytes + 1 - size)]
                    chunks.append(chunk)
                    size += len(chunk)
                    if self.max_response_bytes is not None and size > self.max_response_bytes:
                        break
                raw = b"".join(chunks)
                metadata = response_headers(response.headers)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            retryable = isinstance(exc, (aiohttp.ClientConnectionError, asyncio.TimeoutError))
            raise CloudConnectionError(exc, round((time.monotonic() - started) * 1000),
                                       status, retryable=retryable) from exc
        return parse_response(status, round((time.monotonic() - started) * 1000), raw,
                              self.max_response_bytes, metadata)
