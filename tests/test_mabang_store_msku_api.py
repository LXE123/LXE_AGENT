from __future__ import annotations

import asyncio
import json
import sys
import types
from io import BytesIO
from pathlib import Path

import pytest

from services.mabang.amazon.fba import store_msku as msku
from services.mabang.auth import MabangAuthContext


def _xlsx_bytes(rows: list[dict[str, str]], *, columns: list[str] | None = None) -> bytes:
    from openpyxl import Workbook

    if columns is None:
        columns = ["店铺名称", "MSKU", "ASIN", "本地SKU"]
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.append(columns)
    for row in rows:
        worksheet.append([row.get(column, "") for column in columns])
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()


def _write_xlsx(path: Path, *, columns: list[str] | None = None) -> Path:
    path.write_bytes(_xlsx_bytes([{"店铺名称": "Shop-A", "MSKU": "MSKU-A"}], columns=columns))
    return path


class _FakeResponse:
    def __init__(
        self,
        payload: dict | None = None,
        *,
        status: int = 200,
        body: bytes = b"",
        text_body: str | None = None,
    ) -> None:
        self.status = status
        self._payload = dict(payload or {})
        self._body = body
        self._text_body = text_body

    async def text(self) -> str:
        if self._text_body is not None:
            return self._text_body
        return json.dumps(self._payload, ensure_ascii=False)

    async def json(self, content_type=None) -> dict:
        if self._text_body is not None:
            raise ValueError("not json")
        return dict(self._payload)

    async def read(self) -> bytes:
        return self._body


class _FakeRequest:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response

    async def __aenter__(self) -> _FakeResponse:
        return self._response

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
        scope="private_amz",
        account="",
        source="test",
        cookies_by_domain={
            ".mabangerp.com": [
                {"name": "PHPSESSID", "value": "sid", "domain": ".mabangerp.com"},
                {"name": "signed", "value": "signed-value", "domain": ".mabangerp.com"},
                {"name": "route", "value": "route-value", "domain": ".mabangerp.com"},
                {
                    "name": "MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE",
                    "value": "memcache-key",
                    "domain": ".mabangerp.com",
                },
                {
                    "name": "MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS",
                    "value": "login-plus",
                    "domain": ".mabangerp.com",
                },
            ]
        },
        free_token="",
        wms_cookie_header="",
        raw={},
    )


def _form_value(call: dict, name: str) -> str:
    for key, value in call.get("data", []):
        if key == name:
            return value
    raise AssertionError(f"missing form field: {name}")


def _form_values(call: dict, name: str) -> list[str]:
    return [value for key, value in call.get("data", []) if key == name]


def test_fetch_store_msku_ids_posts_fba_warehouse_form(monkeypatch) -> None:
    fake_session = _FakeSession([_FakeResponse({"success": True, "id": "683425,618589"})])
    monkeypatch.setattr(msku, "erp_http_session", fake_session)

    result = asyncio.run(
        msku.fetch_store_msku_ids(
            "1039477",
            "fbaWarehouseIds[]",
            cookie_header="PHPSESSID=sid",
        )
    )

    assert result == ["683425", "618589"]
    call = fake_session.calls[0]
    assert call["url"] == msku.DEFAULT_LISTSEARCH_URL
    assert _form_value(call, "fbaWarehouseIds[]") == "1039477"
    assert _form_value(call, "shopId") == ""
    assert _form_value(call, "status") == "1"
    assert _form_value(call, "isChange") == "1"
    assert _form_value(call, "atn") == "list"
    assert _form_value(call, "searchtype") == "4"
    assert _form_value(call, "selecttype") == "platformSkuIn"
    assert _form_value(call, "platformSkuData") == ""


def test_fetch_store_msku_ids_posts_shop_id_form(monkeypatch) -> None:
    fake_session = _FakeSession([_FakeResponse({"success": True, "id": "697456821"})])
    monkeypatch.setattr(msku, "erp_http_session", fake_session)

    result = asyncio.run(
        msku.fetch_store_msku_ids(
            "697456821",
            "shopId",
            cookie_header="PHPSESSID=sid",
        )
    )

    assert result == ["697456821"]
    call = fake_session.calls[0]
    assert "fbaWarehouseIds[]" not in [key for key, _ in call["data"]]
    assert _form_value(call, "shopId") == "697456821"


def test_parse_store_msku_ids_rejects_empty() -> None:
    with pytest.raises(msku.StoreMskuDownloadError, match="缺少 id"):
        msku.parse_store_msku_ids({"success": True, "id": ""})


def test_export_store_msku_file_url_posts_full_export_form(monkeypatch) -> None:
    fake_session = _FakeSession([_FakeResponse({"success": True, "gourl": "https://upload.example.test/a.xls"})])
    monkeypatch.setattr(msku, "erp_http_session", fake_session)

    url = asyncio.run(
        msku.export_store_msku_file_url(
            ["719829", "616892"],
            cookie_header="PHPSESSID=sid",
            memcache_key="memcache-key",
        )
    )

    call = fake_session.calls[0]
    assert url == "https://upload.example.test/a.xls"
    assert call["url"] == msku.DEFAULT_FBA_EXPORT_URL
    assert _form_value(call, "orderIds") == "719829\r\n616892"
    assert _form_values(call, "fieldlabel") == list(msku.STORE_MSKU_FIELDLABELS)
    assert _form_values(call, "map-name[]") == [name for name, _ in msku.STORE_MSKU_EXPORT_FIELDS]
    assert _form_values(call, "map-uq[]") == [uq for _, uq in msku.STORE_MSKU_EXPORT_FIELDS]
    assert _form_values(call, "map-text[]") == [map_text for _, _, map_text in msku.STORE_MSKU_EXPORT_FIELD_DEFS]
    assert "uq122" not in _form_values(call, "fieldlabel")
    assert "uq185" not in _form_values(call, "fieldlabel")
    assert "uq122" not in _form_values(call, "map-uq[]")
    assert "uq185" not in _form_values(call, "map-uq[]")
    assert "本地库存" not in _form_values(call, "map-name[]")
    assert "总库存量(默认设置)" not in _form_values(call, "map-name[]")
    assert "uq201" in _form_values(call, "fieldlabel")
    assert "uq202" in _form_values(call, "fieldlabel")
    assert "uq201" in _form_values(call, "map-uq[]")
    assert "uq202" in _form_values(call, "map-uq[]")
    assert "待调仓" in _form_values(call, "map-name[]")
    assert "调仓中" in _form_values(call, "map-name[]")
    assert "uq131" in _form_values(call, "fieldlabel")
    assert "uq131" in _form_values(call, "map-uq[]")
    weight_index = _form_values(call, "map-name[]").index("单品重量(g)(cm)")
    assert _form_values(call, "map-uq[]")[weight_index] == "uq131"
    assert _form_values(call, "map-text[]")[weight_index] == "1"
    assert all(
        value == ""
        for index, value in enumerate(_form_values(call, "map-text[]"))
        if index != weight_index
    )
    assert _form_value(call, "templateId") == "1052958"
    assert _form_value(call, "datasOpen") == "2"
    assert _form_value(call, "memcacheKey") == "memcache-key"
    assert _form_value(call, "operateType") == "5"
    assert _form_value(call, "isMerage") == "2"


def test_download_store_msku_excel_downloads_xlsx(monkeypatch, tmp_path) -> None:
    fake_session = _FakeSession(
        [
            _FakeResponse({"success": True, "id": "1001,1002,1003"}),
            _FakeResponse({"success": True, "gourl": "https://upload.example.test/store.xlsx"}),
            _FakeResponse(body=_xlsx_bytes([{"店铺名称": "Amazon-Lerxiuer-FR", "MSKU": "MSKU-A"}])),
        ]
    )
    monkeypatch.setattr(msku, "get_auth_context", _fake_auth_context)
    monkeypatch.setattr(msku, "erp_http_session", fake_session)
    monkeypatch.setattr(msku, "external_http_session", fake_session)
    monkeypatch.setattr(msku, "_timestamp_text", lambda *_args, **_kwargs: "202605251530")

    result = asyncio.run(
        msku.download_store_msku_excel(
            "697456821",
            "shopId",
            store_name="Amazon-Lerxiuer-FR",
            output_dir=tmp_path,
        )
    )

    assert result.to_payload() == {
        "success": True,
        "store_name": "Amazon-Lerxiuer-FR",
        "store_id": "697456821",
        "id_type": "shopId",
        "id_count": 3,
        "xlsx_path": str(tmp_path / "202605251530-Amazon-Lerxiuer-FR_msku_data.xlsx"),
        "converted": False,
        "raw_excel_deleted": False,
        "source": "mabang_store_msku_download",
    }
    assert Path(result.xlsx_path).is_file()
    assert len([call for call in fake_session.calls if call["method"] == "POST"]) == 2
    assert len([call for call in fake_session.calls if call["method"] == "GET"]) == 1


def test_download_store_msku_excel_requires_store_name() -> None:
    with pytest.raises(ValueError, match="store_name 不能为空"):
        asyncio.run(msku.download_store_msku_excel("697456821", "shopId"))


def test_download_store_msku_excel_overwrites_same_minute_file(monkeypatch, tmp_path) -> None:
    target_path = tmp_path / "202605251530-Amazon-Lerxiuer-FR_msku_data.xlsx"
    target_path.write_bytes(b"old-file")
    new_body = _xlsx_bytes([{"店铺名称": "Amazon-Lerxiuer-FR", "MSKU": "MSKU-NEW"}])
    fake_session = _FakeSession(
        [
            _FakeResponse({"success": True, "id": "1001"}),
            _FakeResponse({"success": True, "gourl": "https://upload.example.test/store.xlsx"}),
            _FakeResponse(body=new_body),
        ]
    )
    monkeypatch.setattr(msku, "get_auth_context", _fake_auth_context)
    monkeypatch.setattr(msku, "erp_http_session", fake_session)
    monkeypatch.setattr(msku, "external_http_session", fake_session)
    monkeypatch.setattr(msku, "_timestamp_text", lambda *_args, **_kwargs: "202605251530")

    result = asyncio.run(
        msku.download_store_msku_excel(
            "697456821",
            "shopId",
            store_name="Amazon-Lerxiuer-FR",
            output_dir=tmp_path,
        )
    )

    assert result.xlsx_path == str(target_path)
    assert target_path.read_bytes() == new_body


def test_normalize_store_msku_excel_converts_xls_and_deletes_raw(monkeypatch, tmp_path) -> None:
    xls_path = tmp_path / "202605251530-Amazon-Lerxiuer-FR_msku_data.xls"
    xls_path.write_bytes(b"legacy-xls")
    calls: list[dict] = []

    class FakeSheet:
        name = "Sheet1"
        nrows = 2
        ncols = len(msku.CORE_STORE_MSKU_HEADERS)

        def cell_value(self, row_index: int, column_index: int) -> str:
            if row_index == 0:
                return msku.CORE_STORE_MSKU_HEADERS[column_index]
            return f"value-{column_index}"

    class FakeBook:
        def sheet_by_index(self, index: int) -> FakeSheet:
            assert index == 0
            return FakeSheet()

    def fake_open_workbook(filename: str, **kwargs):
        calls.append({"filename": filename, **kwargs})
        return FakeBook()

    monkeypatch.setitem(sys.modules, "xlrd", types.SimpleNamespace(open_workbook=fake_open_workbook))

    xlsx_path, converted, raw_deleted = msku.normalize_store_msku_excel(xls_path)

    assert xlsx_path == tmp_path / "202605251530-Amazon-Lerxiuer-FR_msku_data.xlsx"
    assert converted is True
    assert raw_deleted is True
    assert not xls_path.exists()
    assert xlsx_path.is_file()
    assert calls == [{"filename": str(xls_path), "ignore_workbook_corruption": True}]
    msku.validate_store_msku_excel_headers(xlsx_path)


def test_validate_store_msku_excel_headers_requires_core_columns(tmp_path) -> None:
    xlsx_path = _write_xlsx(tmp_path / "missing.xlsx", columns=["店铺名称", "MSKU"])

    with pytest.raises(msku.StoreMskuDownloadError, match="缺少列: ASIN, 本地SKU"):
        msku.validate_store_msku_excel_headers(xlsx_path)


def test_fetch_store_msku_ids_rejects_auth_failure(monkeypatch) -> None:
    fake_session = _FakeSession([_FakeResponse(status=403, text_body="forbidden")])
    monkeypatch.setattr(msku, "erp_http_session", fake_session)

    with pytest.raises(msku.StoreMskuDownloadAuthError, match="鉴权失败"):
        asyncio.run(msku.fetch_store_msku_ids("101", "fbaWarehouseIds[]", cookie_header="PHPSESSID=sid"))


def test_fetch_store_msku_ids_rejects_non_json(monkeypatch) -> None:
    fake_session = _FakeSession([_FakeResponse(text_body="not-json")])
    monkeypatch.setattr(msku, "erp_http_session", fake_session)

    with pytest.raises(msku.StoreMskuDownloadError, match="返回非JSON对象"):
        asyncio.run(msku.fetch_store_msku_ids("101", "fbaWarehouseIds[]", cookie_header="PHPSESSID=sid"))


def test_fetch_store_msku_ids_rejects_business_failure(monkeypatch) -> None:
    fake_session = _FakeSession([_FakeResponse({"success": False, "msg": "bad request"})])
    monkeypatch.setattr(msku, "erp_http_session", fake_session)

    with pytest.raises(msku.StoreMskuDownloadError, match="业务异常: bad request"):
        asyncio.run(msku.fetch_store_msku_ids("101", "fbaWarehouseIds[]", cookie_header="PHPSESSID=sid"))


def test_export_store_msku_file_url_requires_gourl(monkeypatch) -> None:
    fake_session = _FakeSession([_FakeResponse({"success": True})])
    monkeypatch.setattr(msku, "erp_http_session", fake_session)

    with pytest.raises(msku.StoreMskuDownloadError, match="缺少 gourl"):
        asyncio.run(
            msku.export_store_msku_file_url(
                ["1001"],
                cookie_header="PHPSESSID=sid",
                memcache_key="memcache-key",
            )
        )
