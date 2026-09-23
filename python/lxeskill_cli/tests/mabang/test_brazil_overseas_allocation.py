from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from mabang_test_helpers import _xls_bytes
from services.mabang.brazil_overseas import allocation
from services.mabang.brazil_overseas.contracts import BrazilExportKind
from services.mabang.errors import MabangRequestError
from services.mabang.export_common import PrivateAmzExportAuth
from services.mabang.auth import MabangAuthContext


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


async def _fake_auth() -> PrivateAmzExportAuth:
    return PrivateAmzExportAuth(
        private_amz_cookie_header="test-private-amz-cookie-header",
        private_cookie_header="test-private-cookie-header",
        memcache_key="test-memcache-key",
    )


def test_allocation_uses_existing_auth_only(monkeypatch) -> None:
    observed: list[str] = []

    async def fake_existing_auth(*args, **kwargs) -> MabangAuthContext:
        observed.append(str(kwargs["purpose"]))
        return MabangAuthContext(
            account="test",
            source="test",
            cookies_by_domain={
                ".mabangerp.com": [
                    {"name": "PHPSESSID", "value": "test-session", "domain": ".mabangerp.com"},
                    {"name": "mabang_memcache", "value": "test-memcache", "domain": ".mabangerp.com"},
                ]
            },
            free_token="",
            wms_cookie_header="",
        )

    def fake_build_headers(*args, **kwargs) -> PrivateAmzExportAuth:
        return PrivateAmzExportAuth(
            private_amz_cookie_header="test-private-amz-cookie-header",
            private_cookie_header="test-private-cookie-header",
            memcache_key="test-memcache-key",
        )

    monkeypatch.setattr(allocation, "get_existing_auth_context", fake_existing_auth)
    monkeypatch.setattr(allocation, "build_private_amz_headers", fake_build_headers)

    result = asyncio.run(allocation.resolve_brazil_allocation_export_auth())
    assert result.memcache_key == "test-memcache-key"
    assert observed == ["brazil_overseas_allocation_export"]


def _form_values(form: list[tuple[str, str]], name: str) -> list[str]:
    return [value for field_name, value in form if field_name == name]


def _form_value(form: list[tuple[str, str]], name: str) -> str:
    values = _form_values(form, name)
    assert len(values) == 1
    return values[0]


def _setup_success(monkeypatch, *, xls_body: bytes) -> tuple[_FakeSession, _FakeSession]:
    erp_session = _FakeSession(
        [
            _FakeResponse(payload={"success": True, "message": '<input type="checkbox" name="orderIds[]" value="2477220"><input type="checkbox" name="orderIds[]" value="2461000">'}),
            _FakeResponse(payload={"success": True, "gourl": "https://upload.mabangerp.com/stock/orderexport/export.xls"}),
        ]
    )
    download_session = _FakeSession([_FakeResponse(body=xls_body)])
    monkeypatch.setattr(allocation, "erp_http_session", erp_session)
    monkeypatch.setattr(allocation, "external_http_session", download_session)
    monkeypatch.setattr(allocation, "resolve_brazil_allocation_export_auth", _fake_auth)
    return erp_session, download_session


def test_exports_default_three_month_pending_allocation_with_captured_template(monkeypatch, tmp_path: Path) -> None:
    erp_session, download_session = _setup_success(monkeypatch, xls_body=_xls_bytes())

    result = asyncio.run(
        allocation.export_brazil_overseas_allocation(
            BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
            output_dir=tmp_path,
            executed_at=datetime(2026, 9, 18, 6, 30, tzinfo=timezone.utc),
        )
    )

    output_path = tmp_path / "马帮系统-3个月待签收-巴西海外仓-2026-09-18_1430.xls"
    assert result.xlsx_path == str(output_path)
    assert output_path.is_file()
    assert [call["method"] for call in erp_session.calls] == ["POST", "POST"]
    search_call, export_call = erp_session.calls
    assert search_call["url"] == allocation.DEFAULT_ALLOCATION_SEARCH_URL
    search_form = search_call["data"]
    assert _form_value(search_form, "allocationstatus") == "2"
    assert _form_value(search_form, "targetwarhouseId") == "1072376"
    assert _form_value(search_form, "timetype") == "timeCreated"
    assert _form_value(search_form, "datepickerfrom") == ""
    assert _form_value(search_form, "datepickerto") == ""
    assert export_call["url"] == allocation.DEFAULT_ALLOCATION_EXPORT_URL
    export_form = export_call["data"]
    assert _form_value(export_form, "templateId") == "1058049"
    assert _form_value(export_form, "orderIds") == "2477220,2461000,"
    assert _form_value(export_form, "memcacheKey") == "test-memcache-key"
    assert _form_values(export_form, "fieldlabel") == list(allocation.ALLOCATION_FIELDLABELS)
    assert _form_values(export_form, "map-name[]") == [name for name, _ in allocation.ALLOCATION_EXPORT_FIELDS]
    assert _form_values(export_form, "map-uq[]") == [uq for _, uq in allocation.ALLOCATION_EXPORT_FIELDS]
    assert _form_values(export_form, "showRmbColumn") == ["0", "0"]
    assert [call["method"] for call in download_session.calls] == ["GET"]


def test_exports_signed_allocation_before_three_months(monkeypatch, tmp_path: Path) -> None:
    erp_session, _ = _setup_success(monkeypatch, xls_body=_xls_bytes())

    result = asyncio.run(
        allocation.export_brazil_overseas_allocation(
            BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M,
            output_dir=tmp_path,
            executed_at=datetime(2026, 9, 18, 6, 30, tzinfo=timezone.utc),
        )
    )

    assert Path(result.xlsx_path).name == "马帮系统-已签收-巴西海外仓-2026-09-18_1430.xls"
    search_form = erp_session.calls[0]["data"]
    assert _form_value(search_form, "allocationstatus") == "4"
    assert _form_value(search_form, "tablebase") == "2"
    assert _form_value(search_form, "targetwarhouseId") == "1072376"
    assert _form_value(search_form, "datepickerfrom") == ""
    assert _form_value(search_form, "datepickerto") == ""


def test_rejects_non_xls_download_without_writing_file(monkeypatch, tmp_path: Path) -> None:
    _setup_success(monkeypatch, xls_body=b"<html>not an xls</html>")

    with pytest.raises(allocation.BrazilOverseasAllocationExportError, match="未返回 XLS 文件"):
        asyncio.run(
            allocation.export_brazil_overseas_allocation(
                BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
                output_dir=tmp_path,
            )
        )
    assert list(tmp_path.iterdir()) == []


def test_requires_approved_allocation_kind() -> None:
    with pytest.raises(ValueError, match="仅支持"):
        asyncio.run(allocation.export_brazil_overseas_allocation(BrazilExportKind.INVENTORY_SALES_SNAPSHOT))


def test_extracts_unique_order_ids_from_search_html() -> None:
    payload = {
        "message": '<input name="orderIds[]" value="2547022"><input name="orderIds[]" value="2533844">'
        '<input name="orderIds[]" value="2547022">'
    }
    assert allocation._extract_order_ids(payload) == "2547022,2533844,"


def test_extracts_order_ids_from_allocation_detail_links() -> None:
    payload = {
        "message": '<a href="/index.php?mod=warehouseallocation.editallocation&id=2547022&type=2">one</a>'
        '<a href="/index.php?mod=warehouseallocation.editallocation&id=2533844&type=2">two</a>'
    }
    assert allocation._extract_order_ids(payload) == "2547022,2533844,"


def test_stops_when_search_html_has_no_order_ids() -> None:
    with pytest.raises(allocation.BrazilOverseasAllocationExportError, match="未返回可导出的 orderIds"):
        allocation._extract_order_ids({"message": "<div>没有记录</div>"})


def test_stops_when_export_response_has_no_gourl(monkeypatch, tmp_path: Path) -> None:
    erp_session = _FakeSession(
        [
            _FakeResponse(payload={"success": True, "message": '<input name="orderIds[]" value="2477220">'}),
            _FakeResponse(payload={"success": True}),
        ]
    )
    monkeypatch.setattr(allocation, "erp_http_session", erp_session)
    monkeypatch.setattr(allocation, "resolve_brazil_allocation_export_auth", _fake_auth)

    with pytest.raises(allocation.BrazilOverseasAllocationExportError, match="缺少 gourl"):
        asyncio.run(
            allocation.export_brazil_overseas_allocation(
                BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
                output_dir=tmp_path,
            )
        )
    assert [call["method"] for call in erp_session.calls] == ["POST", "POST"]


def test_rejects_unapproved_gourl_before_downloading(monkeypatch, tmp_path: Path) -> None:
    erp_session = _FakeSession(
        [
            _FakeResponse(payload={"success": True, "message": '<input name="orderIds[]" value="2477220">'}),
            _FakeResponse(payload={"success": True, "gourl": "https://example.test/export.xlsx"}),
        ]
    )
    monkeypatch.setattr(allocation, "erp_http_session", erp_session)
    monkeypatch.setattr(allocation, "resolve_brazil_allocation_export_auth", _fake_auth)

    with pytest.raises(allocation.BrazilOverseasAllocationExportError, match="未批准的下载地址"):
        asyncio.run(
            allocation.export_brazil_overseas_allocation(
                BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
                output_dir=tmp_path,
            )
        )
    assert [call["method"] for call in erp_session.calls] == ["POST", "POST"]


def test_stops_on_allocation_search_auth_failure(monkeypatch, tmp_path: Path) -> None:
    erp_session = _FakeSession([_FakeResponse(status=401, body=b"login required")])
    monkeypatch.setattr(allocation, "erp_http_session", erp_session)
    monkeypatch.setattr(allocation, "resolve_brazil_allocation_export_auth", _fake_auth)

    with pytest.raises(allocation.BrazilOverseasAllocationAuthError, match="鉴权失败"):
        asyncio.run(
            allocation.export_brazil_overseas_allocation(
                BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
                output_dir=tmp_path,
            )
        )
    assert [call["method"] for call in erp_session.calls] == ["POST"]


@pytest.mark.parametrize("status", [403, 429])
def test_stops_without_retry_when_allocation_search_is_rejected(monkeypatch, tmp_path: Path, status: int) -> None:
    erp_session = _FakeSession([_FakeResponse(status=status, body=b"blocked")])
    monkeypatch.setattr(allocation, "erp_http_session", erp_session)
    monkeypatch.setattr(allocation, "resolve_brazil_allocation_export_auth", _fake_auth)

    with pytest.raises(MabangRequestError, match="已停止请求"):
        asyncio.run(
            allocation.export_brazil_overseas_allocation(
                BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
                output_dir=tmp_path,
            )
        )
    assert [call["method"] for call in erp_session.calls] == ["POST"]
