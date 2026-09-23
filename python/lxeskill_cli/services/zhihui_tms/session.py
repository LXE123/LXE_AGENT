from __future__ import annotations

from collections.abc import Mapping
from hashlib import sha256
import os
from typing import Any
from urllib.parse import urlsplit

import requests


_ENDPOINT_PATH = "/v1/zhihui-tms-session"
_CAPABILITY_LENGTH = 64
_MAX_API_TOKEN_CHARS = 8_192
_TIMEOUT = (2.0, 5.0)


def _trusted_endpoint(value: str) -> str | None:
    raw = str(value or "").strip().rstrip("/")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65_535
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        return None
    return raw


def _capability(value: str) -> str | None:
    candidate = str(value or "").strip()
    if len(candidate) != _CAPABILITY_LENGTH or any(character not in "0123456789abcdef" for character in candidate):
        return None
    return candidate


def _account_fingerprint(account: str) -> str | None:
    normalized = str(account or "").strip()
    return sha256(normalized.encode("utf-8")).hexdigest() if normalized else None


class ZhihuiTmsSessionProvider:
    """A best-effort bridge to Desktop's encrypted Zhihui session store."""

    def __init__(
        self,
        *,
        endpoint: str,
        capability: str,
        session: requests.Session | Any | None = None,
    ) -> None:
        self._endpoint = _trusted_endpoint(endpoint)
        self._capability = _capability(capability)
        self._session = session or requests.Session()

    @classmethod
    def from_environment(
        cls,
        environment: Mapping[str, str] | None = None,
    ) -> "ZhihuiTmsSessionProvider":
        values = environment if environment is not None else os.environ
        return cls(
            endpoint=str(values.get("LXE_ZHIHUI_TMS_SESSION_HOST_URL", "")),
            capability=str(values.get("LXE_ZHIHUI_TMS_SESSION_HOST_TOKEN", "")),
        )

    def read(self, account: str) -> str | None:
        result = self._call("read", account)
        if not isinstance(result, Mapping):
            return None
        token = result.get("api_token")
        if not isinstance(token, str) or not token or len(token) > _MAX_API_TOKEN_CHARS:
            return None
        return token

    def write(self, account: str, api_token: str) -> None:
        token = str(api_token or "")
        if not token or len(token) > _MAX_API_TOKEN_CHARS:
            return
        self._call("write", account, api_token=token)

    def clear(self, account: str) -> None:
        self._call("clear", account)

    def _call(self, operation: str, account: str, *, api_token: str | None = None) -> Any | None:
        fingerprint = _account_fingerprint(account)
        if self._endpoint is None or self._capability is None or fingerprint is None:
            return None
        payload: dict[str, str] = {"operation": operation, "account_fingerprint": fingerprint}
        if api_token is not None:
            payload["api_token"] = api_token
        try:
            response = self._session.request(
                "POST",
                f"{self._endpoint}{_ENDPOINT_PATH}",
                headers={"Authorization": f"Bearer {self._capability}"},
                json=payload,
                timeout=_TIMEOUT,
                allow_redirects=False,
            )
            if int(response.status_code) != 200:
                return None
            decoded = response.json()
        except (requests.RequestException, TypeError, ValueError, AttributeError):
            return None
        if not isinstance(decoded, Mapping) or decoded.get("ok") is not True:
            return None
        return decoded.get("result")


__all__ = ["ZhihuiTmsSessionProvider"]
