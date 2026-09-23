from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from services.mabang.auth import MabangAuthContext
from services.mabang.brazil_overseas import inventory
from services.mabang.errors import MabangRequestError
from mabang_test_helpers import _xlsx_bytes


class _FakeResponse:
    def __init__(self, *, status: int = 200, payload: dict | None = None, body: bytes = b"") -> None:
        self.status = status
        self._payload = payload
        self._body = body

    async def text(self) -> str:
        return json.dumps(self._payload) if self._payload is not None else self._body.decode("utf-8", errors="replace")

    async def json(self, content_type=None):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload

    async def read(self) -> bytes:
        return self._body


class _FakeRequest:
    def __init__(self, response: _FakeResponse) -> None:
        self.response = response

    async def __aenter__(self) -> _FakeResponse:
        return self.response

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None


class _FakeSession:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def post(self, url: str, **kwargs) -> _FakeRequest:
        self.calls.append({"method": "POST", "url": url, **kwargs})
        return _FakeRequest(self.responses.pop(0))

    def get(self, url: str, **kwargs) -> _FakeRequest:
        self.calls.append({"method": "GET", "url": url, **kwargs})
        return _FakeRequest(self.responses.pop(0))


async def _fake_auth_context(*args, **kwargs) -> MabangAuthContext:
    return MabangAuthContext(
        account="test",
        source="test",
        cookies_by_domain={
            ".mabangerp.com": [{"name": "PHPSESSID", "value": "test-session", "domain": ".mabangerp.com"}],
        },
        free_token="",
        wms_cookie_header="",
    )


def test_inventory_uses_existing_auth_only(monkeypatch) -> None:
    observed: list[str] = []

    async def fake_existing_auth(*args, **kwargs) -> MabangAuthContext:
        observed.append(str(kwargs["purpose"]))
        return await _fake_auth_context()

    monkeypatch.setattr(inventory, "get_existing_auth_context", fake_existing_auth)

    cookie_header = asyncio.run(inventory._resolve_private_amz_cookie())
    assert "PHPSESSID=test-session" in cookie_header
    assert "mabang_lite_rowsPerPage=100" in cookie_header
    assert observed == ["brazil_overseas_inventory_export"]


def _form_as_dict(data: list[tuple[str, str]]) -> dict[str, str]:
    return dict(data)


def test_exports_confirmed_brazil_inventory_filter_to_beijing_named_xlsx(monkeypatch, tmp_path: Path) -> None:
    fake_session = _FakeSession([
        _FakeResponse(payload={"success": True}),
        _FakeResponse(body=_xlsx_bytes([], columns=["库存SKU"])),
    ])
    monkeypatch.setattr(inventory, "erp_http_session", fake_session)
    monkeypatch.setattr(inventory, "get_existing_auth_context", _fake_auth_context)

    result = asyncio.run(
        inventory.export_brazil_overseas_inventory_sales_snapshot(
            output_dir=tmp_path,
            executed_at=datetime(2026, 9, 18, 6, 30, tzinfo=timezone.utc),
        )
    )

    target = tmp_path / "马帮系统-库存-巴西海外仓-2026-09-18_1430.xlsx"
    assert result.xlsx_path == str(target)
    assert target.read_bytes().startswith(b"PK\x03\x04")
    assert result.to_payload()["source_data_note"] == "平台原始库存文件仅含7/28/42天累计销量"
    assert [call["method"] for call in fake_session.calls] == ["POST", "GET"]
    post_call, get_call = fake_session.calls
    assert post_call["url"] == inventory.DEFAULT_WAREHOUSE_SEARCH_URL
    assert _form_as_dict(post_call["data"])["warehouseIdArr"] == "1072376"
    assert _form_as_dict(post_call["data"])["isIdn"] == "1"
    assert get_call["url"] == inventory.DEFAULT_WAREHOUSE_EXPORT_URL
    assert "warehouseIdArr" not in get_call["url"]


def test_rejects_non_xlsx_export_without_writing_file(monkeypatch, tmp_path: Path) -> None:
    fake_session = _FakeSession([
        _FakeResponse(payload={"success": True}),
        _FakeResponse(body=b"<html>login required</html>"),
    ])
    monkeypatch.setattr(inventory, "erp_http_session", fake_session)
    monkeypatch.setattr(inventory, "get_existing_auth_context", _fake_auth_context)

    with pytest.raises(inventory.BrazilOverseasInventoryExportError, match="未返回 XLSX"):
        asyncio.run(inventory.export_brazil_overseas_inventory_sales_snapshot(output_dir=tmp_path))
    assert list(tmp_path.iterdir()) == []


def test_rejects_damaged_xlsx_archive_without_writing_file(monkeypatch, tmp_path: Path) -> None:
    fake_session = _FakeSession([
        _FakeResponse(payload={"success": True}),
        _FakeResponse(body=b"PK\x03\x04not-a-zip-workbook"),
    ])
    monkeypatch.setattr(inventory, "erp_http_session", fake_session)
    monkeypatch.setattr(inventory, "get_existing_auth_context", _fake_auth_context)

    with pytest.raises(inventory.BrazilOverseasInventoryExportError, match="损坏的 XLSX"):
        asyncio.run(inventory.export_brazil_overseas_inventory_sales_snapshot(output_dir=tmp_path))
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("status", [403, 429])
def test_stops_after_export_rejection_without_retry(monkeypatch, tmp_path: Path, status: int) -> None:
    fake_session = _FakeSession([
        _FakeResponse(payload={"success": True}),
        _FakeResponse(status=status, body=b"blocked"),
    ])
    monkeypatch.setattr(inventory, "erp_http_session", fake_session)
    monkeypatch.setattr(inventory, "get_existing_auth_context", _fake_auth_context)

    with pytest.raises(MabangRequestError, match="已停止请求"):
        asyncio.run(inventory.export_brazil_overseas_inventory_sales_snapshot(output_dir=tmp_path))
    assert [call["method"] for call in fake_session.calls] == ["POST", "GET"]


def test_stops_on_search_auth_failure_before_export(monkeypatch, tmp_path: Path) -> None:
    fake_session = _FakeSession([_FakeResponse(status=401, body=b"login required")])
    monkeypatch.setattr(inventory, "erp_http_session", fake_session)
    monkeypatch.setattr(inventory, "get_existing_auth_context", _fake_auth_context)

    with pytest.raises(inventory.BrazilOverseasInventoryAuthError, match="鉴权失败"):
        asyncio.run(inventory.export_brazil_overseas_inventory_sales_snapshot(output_dir=tmp_path))
    assert [call["method"] for call in fake_session.calls] == ["POST"]
