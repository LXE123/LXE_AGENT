from __future__ import annotations

import asyncio
import json
from io import BytesIO
from pathlib import Path

import pytest

from mabang_test_helpers import _form_value, _form_values, _xlsx_bytes
from services.mabang.auth import MabangAuthContext
from services.mabang import stock_sku_export as stock


async def _async_value(value):
    return value


class _FakeResponse:
    def __init__(self, payload: dict | None = None, *, status: int = 200, body: bytes = b"") -> None:
        self.status = status
        self._payload = dict(payload or {})
        self._body = body

    async def text(self) -> str:
        return json.dumps(self._payload, ensure_ascii=False)

    async def json(self, content_type=None) -> dict:
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
        scope="erp",
        account="",
        source="test",
        cookies_by_domain={
            ".mabangerp.com": [
                {"name": "PHPSESSID", "value": "sid", "domain": ".mabangerp.com"},
                {
                    "name": "MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE",
                    "value": "memcache-key",
                    "domain": ".mabangerp.com",
                },
            ]
        },
        free_token="",
        wms_cookie_header="",
        raw={},
    )


async def _fake_auth_without_memcache(*args, **kwargs) -> MabangAuthContext:
    return MabangAuthContext(
        scope="erp",
        account="",
        source="test",
        cookies_by_domain={".mabangerp.com": [{"name": "PHPSESSID", "value": "sid", "domain": ".mabangerp.com"}]},
        free_token="",
        wms_cookie_header="",
        raw={},
    )


def _step_value(call: dict) -> str:
    return _form_value(call, "step")


def test_export_stock_sku_names_runs_subtask_step2_and_parses_xlsx(monkeypatch, tmp_path):
    responses = [
        _FakeResponse({"success_type": 2, "sn": "sn-1", "subtask_num": 6, "chunkNum": 500, "success": True}),
        *[
            _FakeResponse({"updateR": True, "subO": [{"id": str(index), "success": "1"}], "success": True})
            for index in range(1, 7)
        ],
        _FakeResponse({"async": True, "taskId": "task-1", "success": True}),
        _FakeResponse({"success": True, "file_url": "https://cos.example.test/stock.xlsx", "state": 1}),
        _FakeResponse(body=_xlsx_bytes([{"库存SKU": "SKU-A", "库存SKU中文名称": "产品A"}], columns=["库存SKU", "库存SKU中文名称"])),
    ]
    fake_session = _FakeSession(responses)
    monkeypatch.setattr(stock, "erp_http_session", fake_session)
    monkeypatch.setattr(stock, "external_http_session", fake_session)
    monkeypatch.setattr(stock, "get_auth_context", _fake_auth_context)

    result = asyncio.run(
        stock.export_stock_sku_names(
            ["SKU-A"],
            delivery_no="SP260508022",
            output_dir=tmp_path,
            timeout_sec=0,
            poll_interval_sec=0.1,
        )
    )

    post_calls = [call for call in fake_session.calls if call["method"] == "POST"]
    assert [_step_value(call) for call in post_calls] == ["1", "2", "2", "2", "2", "2", "2", "3", "4"]
    assert [_form_value(call, "sub_no") for call in post_calls if _step_value(call) == "2"] == [
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
    ]
    assert _form_value(post_calls[0], "memcacheKey") == "memcache-key"
    assert _form_value(post_calls[0], "orderIds") == "SKU-A\r\n"
    assert _form_values(post_calls[0], "fieldlabel") == [uq for _, uq in stock.STOCK_SKU_EXPORT_FIELDS]
    assert _form_values(post_calls[0], "warehouseIds[]") == ["1014318"]
    assert _form_values(post_calls[0], "map-name[]") == [name for name, _ in stock.STOCK_SKU_EXPORT_FIELDS]
    assert _form_values(post_calls[0], "map-uq[]") == [uq for _, uq in stock.STOCK_SKU_EXPORT_FIELDS]
    assert _form_value(post_calls[0], "hiddenPage") == ""
    assert result.names_by_key == {"SKU-A": "产品A"}
    assert result.xlsx_paths == [str(tmp_path / "SP260508022_batch001.xlsx")]
    assert Path(result.xlsx_paths[0]).is_file()


def test_export_stock_sku_names_splits_batches_over_3000(monkeypatch, tmp_path):
    first_file = _xlsx_bytes([{"库存SKU": "SKU-0001", "库存SKU中文名称": "产品1"}], columns=["库存SKU", "库存SKU中文名称"])
    second_file = _xlsx_bytes([{"库存SKU": "SKU-3001", "库存SKU中文名称": "产品3001"}], columns=["库存SKU", "库存SKU中文名称"])
    responses = []
    for batch_index in range(1, 3):
        responses.extend(
            [
                _FakeResponse(
                    {
                        "success_type": 2,
                        "sn": f"sn-{batch_index}",
                        "subtask_num": 1,
                        "chunkNum": 500,
                        "success": True,
                    }
                ),
                _FakeResponse({"updateR": True, "subO": [{"id": str(batch_index), "success": "1"}], "success": True}),
                _FakeResponse({"async": True, "taskId": f"task-{batch_index}", "success": True}),
                _FakeResponse(
                    {
                        "success": True,
                        "file_url": f"https://cos.example.test/stock-{batch_index}.xlsx",
                        "state": 1,
                    }
                ),
                _FakeResponse(body=first_file if batch_index == 1 else second_file),
            ]
        )
    fake_session = _FakeSession(responses)
    monkeypatch.setattr(stock, "erp_http_session", fake_session)
    monkeypatch.setattr(stock, "external_http_session", fake_session)
    monkeypatch.setattr(stock, "get_auth_context", _fake_auth_context)

    skus = [f"SKU-{index:04d}" for index in range(1, 3002)]
    result = asyncio.run(stock.export_stock_sku_names(skus, delivery_no="SP260508022", output_dir=tmp_path))

    step1_calls = [call for call in fake_session.calls if call["method"] == "POST" and _step_value(call) == "1"]
    assert len(step1_calls) == 2
    assert len(_form_value(step1_calls[0], "orderIds").strip().splitlines()) == 3000
    assert len(_form_value(step1_calls[1], "orderIds").strip().splitlines()) == 1
    assert result.names_by_key == {"SKU-0001": "产品1", "SKU-3001": "产品3001"}
    assert result.xlsx_paths == [
        str(tmp_path / "SP260508022_batch001.xlsx"),
        str(tmp_path / "SP260508022_batch002.xlsx"),
    ]


def test_export_stock_sku_names_requires_memcache_cookie(monkeypatch):
    monkeypatch.setattr(stock, "get_auth_context", _fake_auth_without_memcache)

    with pytest.raises(stock.StockSkuExportAuthError, match="MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE"):
        asyncio.run(stock.export_stock_sku_names(["SKU-A"]))


def test_export_stock_sku_batch_rejects_failed_step2(monkeypatch):
    fake_session = _FakeSession(
        [
            _FakeResponse({"success_type": 2, "sn": "sn-1", "subtask_num": 1, "chunkNum": 500, "success": True}),
            _FakeResponse({"updateR": True, "subO": [{"id": "1", "success": "0"}], "success": True}),
        ]
    )
    monkeypatch.setattr(stock, "erp_http_session", fake_session)
    monkeypatch.setattr(stock, "_resolve_private_auth", lambda: _async_value(("PHPSESSID=sid", "memcache-key")))

    with pytest.raises(stock.StockSkuExportError, match="Step 2 失败"):
        asyncio.run(
            stock.export_stock_sku_batch(
                ["SKU-A"],
                delivery_no="SP260508022",
                batch_index=1,
            )
        )


def test_export_stock_sku_batch_requires_step3_task_id(monkeypatch):
    fake_session = _FakeSession(
        [
            _FakeResponse({"success_type": 2, "sn": "sn-1", "subtask_num": 1, "chunkNum": 500, "success": True}),
            _FakeResponse({"updateR": True, "subO": [{"id": "1", "success": "1"}], "success": True}),
            _FakeResponse({"async": True, "success": True}),
        ]
    )
    monkeypatch.setattr(stock, "erp_http_session", fake_session)
    monkeypatch.setattr(stock, "_resolve_private_auth", lambda: _async_value(("PHPSESSID=sid", "memcache-key")))

    with pytest.raises(stock.StockSkuExportError, match="缺少 taskId"):
        asyncio.run(
            stock.export_stock_sku_batch(
                ["SKU-A"],
                delivery_no="SP260508022",
                batch_index=1,
            )
        )


def test_export_stock_sku_batch_times_out_waiting_for_file(monkeypatch):
    fake_session = _FakeSession(
        [
            _FakeResponse({"success_type": 2, "sn": "sn-1", "subtask_num": 1, "chunkNum": 500, "success": True}),
            _FakeResponse({"updateR": True, "subO": [{"id": "1", "success": "1"}], "success": True}),
            _FakeResponse({"async": True, "taskId": "task-1", "success": True}),
            _FakeResponse({"success": True, "state": 0}),
        ]
    )
    monkeypatch.setattr(stock, "erp_http_session", fake_session)
    monkeypatch.setattr(stock, "_resolve_private_auth", lambda: _async_value(("PHPSESSID=sid", "memcache-key")))

    with pytest.raises(stock.StockSkuExportTimeoutError, match="库存SKU导出超时"):
        asyncio.run(
            stock.export_stock_sku_batch(
                ["SKU-A"],
                delivery_no="SP260508022",
                batch_index=1,
                timeout_sec=0,
                poll_interval_sec=0.1,
            )
        )


def test_load_stock_sku_names_requires_columns(tmp_path):
    xlsx_path = tmp_path / "stock.xlsx"
    xlsx_path.write_bytes(_xlsx_bytes([{"库存SKU": "SKU-A"}], columns=["库存SKU"]))

    with pytest.raises(RuntimeError, match="缺少列: 库存SKU中文名称"):
        stock.load_stock_sku_names(xlsx_path)


def test_load_stock_sku_names_reports_empty_export(tmp_path):
    from openpyxl import Workbook

    xlsx_path = tmp_path / "empty-stock.xlsx"
    workbook = Workbook()
    workbook.save(xlsx_path)

    with pytest.raises(RuntimeError, match="库存SKU导出结果为空"):
        stock.load_stock_sku_names(xlsx_path)
