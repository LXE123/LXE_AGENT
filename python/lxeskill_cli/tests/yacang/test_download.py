from __future__ import annotations

import base64
import hashlib
from pathlib import Path
from typing import Any

import pytest
import requests

from services.yacang.download import DOWNLOAD_TIMEOUT, XLSX_CONTENT_TYPE, download_xlsx
from services.yacang.errors import YacangError
from services.yacang.production import MemoryCooldownStore, MemoryRequestGate, YacangProductionGuard


def _guard() -> YacangProductionGuard:
    return YacangProductionGuard(
        enabled=True,
        cooldown=MemoryCooldownStore(),
        request_gate=MemoryRequestGate(),
    )


class FakeResponse:
    def __init__(
        self,
        body: bytes,
        *,
        content_type: str = XLSX_CONTENT_TYPE,
        md5: str = "",
        status_code: int = 200,
    ) -> None:
        self.status_code = status_code
        self.text = body.decode("utf-8", errors="replace")
        self.headers = {
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
            **({"Content-MD5": md5} if md5 else {}),
        }
        self._body = body

    def iter_content(self, *, chunk_size: int) -> list[bytes]:
        return [self._body[index:index + chunk_size] for index in range(0, len(self._body), chunk_size)]


class FakeSession:
    def __init__(self, response: FakeResponse | list[FakeResponse | Exception]) -> None:
        self.responses = list(response) if isinstance(response, list) else [response]
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def get(self, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append((url, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_download_accepts_only_valid_oss_xlsx_and_verifies_md5(tmp_path: Path) -> None:
    body = b"PK\x03\x04fake-xlsx"
    digest = base64.b64encode(hashlib.md5(body, usedforsecurity=False).digest()).decode("ascii")
    session = FakeSession(FakeResponse(body, md5=digest))
    destination = tmp_path / "result.xlsx"

    download_xlsx(
        session,
        "https://oss-accelerate.seaya.cn/example/result.xlsx",
        destination,
        production_guard=_guard(),
    )

    assert destination.read_bytes() == body
    assert session.calls[0][1]["allow_redirects"] is False
    assert session.calls[0][1]["timeout"] == DOWNLOAD_TIMEOUT
    assert not destination.with_suffix(".xlsx.part").exists()


def test_download_rejects_untrusted_host_before_network(tmp_path: Path) -> None:
    session = FakeSession(FakeResponse(b"PK\x03\x04fake"))

    with pytest.raises(YacangError, match="不受信任"):
        download_xlsx(
            session,
            "https://example.com/private.xlsx",
            tmp_path / "result.xlsx",
            production_guard=_guard(),
        )

    assert session.calls == []


def test_download_rejects_json_error_page_and_does_not_publish_file(tmp_path: Path) -> None:
    session = FakeSession(FakeResponse(b'{"status":0}', content_type="application/json"))
    destination = tmp_path / "result.xlsx"

    with pytest.raises(YacangError, match="Content-Type 无效"):
        download_xlsx(
            session,
            "https://oss-accelerate.seaya.cn/example/result.xlsx",
            destination,
            production_guard=_guard(),
        )

    assert not destination.exists()


def test_missing_content_md5_is_allowed_when_other_download_checks_pass(tmp_path: Path) -> None:
    destination = tmp_path / "result.xlsx"
    download_xlsx(
        FakeSession(FakeResponse(b"PK\x03\x04valid-without-md5")),
        "https://oss-accelerate.seaya.cn/example/result.xlsx",
        destination,
        production_guard=_guard(),
    )
    assert destination.is_file()


def test_present_content_md5_mismatch_is_rejected_without_fallback(tmp_path: Path) -> None:
    destination = tmp_path / "result.xlsx"
    with pytest.raises(YacangError) as caught:
        download_xlsx(
            FakeSession(FakeResponse(b"PK\x03\x04bad-md5", md5="not-the-digest")),
            "https://oss-accelerate.seaya.cn/example/result.xlsx",
            destination,
            production_guard=_guard(),
        )
    assert caught.value.code == "XLSX_MD5_MISMATCH"
    assert not destination.exists()


def test_download_network_error_retries_once_after_five_seconds(tmp_path: Path) -> None:
    session = FakeSession([
        requests.Timeout("temporary"),
        FakeResponse(b"PK\x03\x04valid"),
    ])
    sleeps: list[float] = []
    download_xlsx(
        session,
        "https://oss-accelerate.seaya.cn/example/result.xlsx",
        tmp_path / "result.xlsx",
        production_guard=_guard(),
        sleep=sleeps.append,
    )
    assert len(session.calls) == 2
    assert sleeps == [5.0]


def test_download_5xx_retries_once_after_five_seconds(tmp_path: Path) -> None:
    session = FakeSession([
        FakeResponse(b"temporary", status_code=503),
        FakeResponse(b"PK\x03\x04valid"),
    ])
    sleeps: list[float] = []
    download_xlsx(
        session,
        "https://oss-accelerate.seaya.cn/example/result.xlsx",
        tmp_path / "result.xlsx",
        production_guard=_guard(),
        sleep=sleeps.append,
    )
    assert len(session.calls) == 2
    assert sleeps == [5.0]


def test_download_429_activates_cooldown_without_retry(tmp_path: Path) -> None:
    session = FakeSession(FakeResponse(b"rate limited", status_code=429))
    cooldown = MemoryCooldownStore()
    guard = YacangProductionGuard(
        enabled=True,
        cooldown=cooldown,
        request_gate=MemoryRequestGate(),
    )
    with pytest.raises(YacangError) as caught:
        download_xlsx(
            session,
            "https://oss-accelerate.seaya.cn/example/result.xlsx",
            tmp_path / "result.xlsx",
            production_guard=guard,
        )
    assert caught.value.code == "YACANG_RATE_LIMITED"
    assert len(session.calls) == 1
    assert cooldown.remaining_seconds() == 900


def test_download_rejects_bad_magic_and_removes_partial_file(tmp_path: Path) -> None:
    destination = tmp_path / "result.xlsx"
    with pytest.raises(YacangError) as caught:
        download_xlsx(
            FakeSession(FakeResponse(b"not-an-xlsx")),
            "https://oss-accelerate.seaya.cn/example/result.xlsx",
            destination,
            production_guard=_guard(),
        )
    assert caught.value.code == "XLSX_MAGIC_INVALID"
    assert not destination.exists()
    assert not destination.with_suffix(".xlsx.part").exists()


def test_production_disabled_blocks_download_before_network(tmp_path: Path) -> None:
    session = FakeSession([])
    guard = YacangProductionGuard(
        enabled=False,
        cooldown=MemoryCooldownStore(),
        request_gate=MemoryRequestGate(),
    )
    with pytest.raises(YacangError) as caught:
        download_xlsx(
            session,
            "https://oss-accelerate.seaya.cn/example/result.xlsx",
            tmp_path / "result.xlsx",
            production_guard=guard,
        )
    assert caught.value.code == "YACANG_PROD_DISABLED"
    assert session.calls == []
