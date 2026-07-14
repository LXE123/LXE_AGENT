from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from services.browser.workflows import amazon_fba_shipment_files as fba_shipment_tools
from services.agent_cli.mabang import download_wms_consignment_excel as cli
from services.amazon.amazon_logistic.sources import consignment_excel as consignment_source
import services.mabang.auth as mabang_auth
import services.mabang.amazon.fba.wms as wms_module
from shared.repository import repository_root


def _write_consignment_excel(path: Path, box_count: int) -> None:
    import pandas as pd

    rows = []
    for box_no in range(1, int(box_count) + 1):
        rows.append(
            {
                "箱子编号": box_no,
                "箱序号": box_no,
                "MSKU": f"SKU-{box_no}-A",
                "FBA商品名称": f"Product {box_no} A",
                "库存sku": f"LOCAL-{box_no}-A",
                "库存sku中文名称": f"商品 {box_no} A",
                "FNSKU": f"FNSKU-{box_no}-A",
                "装箱数量": 1,
                "长": 10,
                "宽": 20,
                "高": 30,
                "毛重": 12.5,
            }
        )
        rows.append(
            {
                "箱子编号": box_no,
                "箱序号": box_no,
                "MSKU": f"SKU-{box_no}-B",
                "FBA商品名称": f"Product {box_no} B",
                "库存sku": f"LOCAL-{box_no}-B",
                "库存sku中文名称": f"商品 {box_no} B",
                "FNSKU": f"FNSKU-{box_no}-B",
                "装箱数量": 2,
                "长": 10,
                "宽": 20,
                "高": 30,
                "毛重": 12.5,
            }
        )
    pd.DataFrame(rows).to_excel(path, sheet_name="FBA装箱任务", index=False)


def _read_excel(path: str | Path):
    import pandas as pd

    return pd.read_excel(path, sheet_name="FBA装箱任务")


def test_relative_wms_dirs_resolve_from_workspace_root():
    workspace_root = repository_root()
    expected = workspace_root / "artifacts" / "mabang_wms_consignment"

    assert consignment_source.resolve_consignment_excel_dir() == expected
    assert wms_module._resolve_excel_dir() == expected


def test_prepare_upload_local_consignment_uses_shared_lookup(monkeypatch, tmp_path: Path):
    cache_dir = tmp_path / "artifacts" / "mabang_wms_consignment"
    excel_path = cache_dir / "SP260515001.xlsx"
    calls: list[str] = []

    def fake_find_consignment_excel(consignment_no: str) -> Path:
        calls.append(consignment_no)
        return excel_path

    monkeypatch.setattr(fba_shipment_tools, "find_consignment_excel", fake_find_consignment_excel)
    monkeypatch.setattr(fba_shipment_tools, "resolve_consignment_excel_dir", lambda: cache_dir)

    payload = fba_shipment_tools.prepare_upload_local_consignment_excel_payload("sp260515001")

    assert calls == ["SP260515001"]
    assert payload["consignment_no"] == "SP260515001"
    assert payload["excel_path"] == str(excel_path)
    assert payload["source"] == "local"


def test_prepare_upload_local_consignment_missing_uses_shared_cache_error(monkeypatch, tmp_path: Path):
    cache_dir = tmp_path / "artifacts" / "mabang_wms_consignment"
    cache_dir.mkdir(parents=True)
    monkeypatch.setattr(consignment_source, "resolve_consignment_excel_dir", lambda: cache_dir)

    with pytest.raises(RuntimeError) as exc_info:
        fba_shipment_tools.prepare_upload_local_consignment_excel_payload("SP260515001")

    message = str(exc_info.value)
    assert str(cache_dir) in message
    assert "services\\test_file" not in message
    assert "services/test_file" not in message


def test_prepare_upload_legacy_test_file_helpers_removed():
    assert not hasattr(fba_shipment_tools, "_resolve_prepare_upload_test_file_dir")
    assert not hasattr(fba_shipment_tools, "_find_prepare_upload_consignment_excel")


def test_get_fba_wms_cookie_header_passes_force_refresh(monkeypatch) -> None:
    calls: list[dict] = []
    audit_calls: list[dict] = []

    async def fake_ensure_payload(**kwargs):
        calls.append(kwargs)
        return {
            "success": True,
            "scope": "fba",
            "account": "account",
            "source": "refresh",
            "cookies_by_domain": {},
            "free_token": "",
            "wms_cookie_header": "wms-cookie=1",
        }

    monkeypatch.setattr(mabang_auth, "ensure_mabang_auth_payload", fake_ensure_payload)
    monkeypatch.setattr(mabang_auth.auth_audit, "log_auth_material_acquired", lambda **kwargs: audit_calls.append(kwargs))

    cookie_header = asyncio.run(
        mabang_auth.get_fba_wms_cookie_header(
            force_refresh=True,
            purpose="wms_consignment_excel_export",
        )
    )

    assert cookie_header == "wms-cookie=1"
    assert calls == [
        {
            "scope": "fba",
            "account": "",
            "require_wms_cookie_header": True,
            "force_refresh": True,
        }
    ]
    assert audit_calls == [
        {
            "purpose": "wms_consignment_excel_export",
            "caller": "services.mabang.auth.get_auth_context",
            "scope": "fba",
            "source": "refresh",
            "force_refresh": True,
            "cookies_by_domain": {},
            "free_token": "",
            "wms_cookie_header": "wms-cookie=1",
        }
    ]


def _wms_login_html() -> bytes:
    return (
        '<!DOCTYPE html><html><head><title>马帮WMS</title></head>'
        '<body><form action="/login" method="post">'
        '<input id="userName" name="userName">'
        '<input id="pwd" name="pwd" type="password">'
        "</form></body></html>"
    ).encode("utf-8")


def test_wms_uses_shared_auth_material_consumption_audit(monkeypatch, tmp_path: Path) -> None:
    audit_calls: list[dict] = []

    async def fake_get_cookie(force_refresh: bool = False, purpose: str = "") -> str:
        return "PHPSESSID=secret-sid; route=secret-route"

    async def fake_request(ship_no: str, cookie_header: str):
        return 200, b"excel-bytes", "application/vnd.ms-excel", 'attachment; filename="pack.xls"'

    def fake_audit(**kwargs):
        audit_calls.append(kwargs)

    monkeypatch.setattr(wms_module, "get_fba_wms_cookie_header", fake_get_cookie)
    monkeypatch.setattr(wms_module, "_request_once", fake_request)
    monkeypatch.setattr(wms_module, "_resolve_excel_dir", lambda: tmp_path)
    monkeypatch.setattr(wms_module.auth_audit, "log_auth_material_consumed", fake_audit)
    monkeypatch.setattr(wms_module.wms_settings, "FBA_LOGISTICS_WMS_EXPORT_RETRY", 0)

    path = asyncio.run(wms_module.download_consignment_excel_from_wms("SP260627014"))

    assert path.read_bytes() == b"excel-bytes"
    assert audit_calls
    assert audit_calls[0]["purpose"] == "wms_consignment_excel_export"
    assert audit_calls[0]["auth_kind"] == "wms_cookie_header"
    assert audit_calls[0]["force_refresh"] is False
    assert not hasattr(wms_module, "_cookie_header_name_summary")
    assert not hasattr(wms_module, "_session_cookie_jar_name_summary")


def test_wms_login_page_html_triggers_force_refresh_and_retry(monkeypatch, tmp_path: Path) -> None:
    token_calls: list[bool] = []
    request_cookies: list[str] = []
    responses = [
        (200, _wms_login_html(), "text/html;charset=UTF-8", ""),
        (200, b"excel-bytes", "application/vnd.ms-excel", 'attachment; filename="pack.xls"'),
    ]

    async def fake_get_cookie(force_refresh: bool = False, purpose: str = "") -> str:
        token_calls.append(force_refresh)
        return "wms-cookie=fresh" if force_refresh else "wms-cookie=stale"

    async def fake_request(ship_no: str, cookie_header: str):
        request_cookies.append(cookie_header)
        return responses.pop(0)

    monkeypatch.setattr(wms_module, "get_fba_wms_cookie_header", fake_get_cookie)
    monkeypatch.setattr(wms_module, "_request_once", fake_request)
    monkeypatch.setattr(wms_module, "_resolve_excel_dir", lambda: tmp_path)
    monkeypatch.setattr(wms_module.wms_settings, "FBA_LOGISTICS_WMS_EXPORT_RETRY", 0)

    path = asyncio.run(wms_module.download_consignment_excel_from_wms("SP260627014"))

    assert path == tmp_path / "SP260627014.xls"
    assert path.read_bytes() == b"excel-bytes"
    assert token_calls == [False, True]
    assert request_cookies == ["wms-cookie=stale", "wms-cookie=fresh"]


def test_wms_http_auth_failure_triggers_force_refresh_and_retry(monkeypatch, tmp_path: Path) -> None:
    token_calls: list[bool] = []
    responses = [
        (401, b"unauthorized", "text/plain", ""),
        (200, b"excel-bytes", "application/vnd.ms-excel", 'attachment; filename="pack.xls"'),
    ]

    async def fake_get_cookie(force_refresh: bool = False, purpose: str = "") -> str:
        token_calls.append(force_refresh)
        return "wms-cookie=fresh" if force_refresh else "wms-cookie=stale"

    async def fake_request(ship_no: str, cookie_header: str):
        return responses.pop(0)

    monkeypatch.setattr(wms_module, "get_fba_wms_cookie_header", fake_get_cookie)
    monkeypatch.setattr(wms_module, "_request_once", fake_request)
    monkeypatch.setattr(wms_module, "_resolve_excel_dir", lambda: tmp_path)
    monkeypatch.setattr(wms_module.wms_settings, "FBA_LOGISTICS_WMS_EXPORT_RETRY", 0)

    path = asyncio.run(wms_module.download_consignment_excel_from_wms("SP260627014"))

    assert path.read_bytes() == b"excel-bytes"
    assert token_calls == [False, True]


def test_wms_auth_failure_after_force_refresh_does_not_loop(monkeypatch, tmp_path: Path) -> None:
    token_calls: list[bool] = []
    responses = [
        (200, _wms_login_html(), "text/html;charset=UTF-8", ""),
        (200, _wms_login_html(), "text/html;charset=UTF-8", ""),
    ]

    async def fake_get_cookie(force_refresh: bool = False, purpose: str = "") -> str:
        token_calls.append(force_refresh)
        return "wms-cookie=fresh" if force_refresh else "wms-cookie=stale"

    async def fake_request(ship_no: str, cookie_header: str):
        return responses.pop(0)

    monkeypatch.setattr(wms_module, "get_fba_wms_cookie_header", fake_get_cookie)
    monkeypatch.setattr(wms_module, "_request_once", fake_request)
    monkeypatch.setattr(wms_module, "_resolve_excel_dir", lambda: tmp_path)
    monkeypatch.setattr(wms_module.wms_settings, "FBA_LOGISTICS_WMS_EXPORT_RETRY", 0)

    with pytest.raises(wms_module.WmsExcelDownloadError, match="已强制刷新后重试仍失败"):
        asyncio.run(wms_module.download_consignment_excel_from_wms("SP260627014"))

    assert token_calls == [False, True]


def test_non_login_html_does_not_force_refresh(monkeypatch, tmp_path: Path) -> None:
    token_calls: list[bool] = []

    async def fake_get_cookie(force_refresh: bool = False, purpose: str = "") -> str:
        token_calls.append(force_refresh)
        return "wms-cookie=stale"

    async def fake_request(ship_no: str, cookie_header: str):
        return 200, b"<html><body>maintenance</body></html>", "text/html;charset=UTF-8", ""

    monkeypatch.setattr(wms_module, "get_fba_wms_cookie_header", fake_get_cookie)
    monkeypatch.setattr(wms_module, "_request_once", fake_request)
    monkeypatch.setattr(wms_module, "_resolve_excel_dir", lambda: tmp_path)
    monkeypatch.setattr(wms_module.wms_settings, "FBA_LOGISTICS_WMS_EXPORT_RETRY", 0)

    with pytest.raises(wms_module.WmsExcelDownloadError, match="非Excel"):
        asyncio.run(wms_module.download_consignment_excel_from_wms("SP260627014"))

    assert token_calls == [False, False]


def test_wms_network_error_keeps_existing_retry_without_force_refresh(monkeypatch, tmp_path: Path) -> None:
    token_calls: list[bool] = []
    request_count = 0

    async def fake_get_cookie(force_refresh: bool = False, purpose: str = "") -> str:
        token_calls.append(force_refresh)
        return "wms-cookie=stale"

    async def fake_request(ship_no: str, cookie_header: str):
        nonlocal request_count
        request_count += 1
        raise asyncio.TimeoutError()

    monkeypatch.setattr(wms_module, "get_fba_wms_cookie_header", fake_get_cookie)
    monkeypatch.setattr(wms_module, "_request_once", fake_request)
    monkeypatch.setattr(wms_module, "_resolve_excel_dir", lambda: tmp_path)
    monkeypatch.setattr(wms_module.wms_settings, "FBA_LOGISTICS_WMS_EXPORT_RETRY", 1)

    with pytest.raises(wms_module.WmsExcelDownloadError, match="WMS 导出最终失败"):
        asyncio.run(wms_module.download_consignment_excel_from_wms("SP260627014"))

    assert token_calls == [False, False]
    assert request_count == 2


def test_missing_ship_no_returns_failure_json(capsys):
    payload = cli.run({})
    assert payload == {
        "success": False,
        "ship_no": "",
        "exception": "ship_no 不能为空",
    }


def test_invalid_ship_no_returns_failure_json(capsys):
    payload = cli.run({"ship_no": "FBA123"})
    assert payload == {
        "success": False,
        "ship_no": "FBA123",
        "exception": "ship_no 格式无效: FBA123",
    }


def test_success_returns_downloaded_excel_path(monkeypatch, tmp_path, capsys):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 4)

    async def fake_download(ship_no: str) -> Path:
        assert ship_no == "SP260226004"
        return excel_path

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    payload = cli.run({"ship_no": "sp260226004"})
    assert payload == {
        "success": True,
        "ship_no": "SP260226004",
        "excel_path": str(excel_path),
        "source": "wms",
        "split_mode": "auto",
        "deliverable_excel_paths": [str(excel_path)],
        "box_count": 4,
        "split_required": False,
        "split_excel_paths": [],
    }


def test_download_error_returns_failure_json(monkeypatch, capsys):
    async def fake_download(ship_no: str) -> Path:
        raise RuntimeError(f"WMS failed for {ship_no}")

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    payload = cli.run({"ship_no": "SP260226004"})
    assert payload == {
        "success": False,
        "ship_no": "SP260226004",
        "exception": "WMS failed for SP260226004",
    }


def test_split_four_boxes_does_not_create_split_files(tmp_path):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 4)

    payload = cli.split_consignment_excel_by_box(excel_path)

    assert payload == {
        "box_count": 4,
        "split_required": False,
        "split_excel_paths": [],
    }
    assert not (tmp_path / "SP260226004-1.xlsx").exists()


def test_split_six_boxes_creates_five_plus_one(tmp_path):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 6)

    payload = cli.split_consignment_excel_by_box(excel_path)

    assert payload["box_count"] == 6
    assert payload["split_required"] is True
    paths = [Path(path) for path in payload["split_excel_paths"]]
    assert [path.name for path in paths] == ["SP260226004-1.xlsx", "SP260226004-2.xlsx"]
    _assert_split_file(paths[0], expected_box_count=5)
    _assert_split_file(paths[1], expected_box_count=1)


def test_split_ten_boxes_creates_two_even_files(tmp_path):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 10)

    payload = cli.split_consignment_excel_by_box(excel_path)

    paths = [Path(path) for path in payload["split_excel_paths"]]
    assert [path.name for path in paths] == ["SP260226004-1.xlsx", "SP260226004-2.xlsx"]
    _assert_split_file(paths[0], expected_box_count=5)
    _assert_split_file(paths[1], expected_box_count=5)


def test_split_twelve_boxes_creates_three_files(tmp_path):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 12)

    payload = cli.split_consignment_excel_by_box(excel_path)

    paths = [Path(path) for path in payload["split_excel_paths"]]
    assert [path.name for path in paths] == [
        "SP260226004-1.xlsx",
        "SP260226004-2.xlsx",
        "SP260226004-3.xlsx",
    ]
    _assert_split_file(paths[0], expected_box_count=5)
    _assert_split_file(paths[1], expected_box_count=5)
    _assert_split_file(paths[2], expected_box_count=2)


def test_cli_success_returns_split_payload(monkeypatch, tmp_path, capsys):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 6)

    async def fake_download(ship_no: str) -> Path:
        assert ship_no == "SP260226004"
        return excel_path

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    payload = cli.run({"ship_no": "SP260226004"})
    assert payload["split_mode"] == "auto"
    assert payload["box_count"] == 6
    assert payload["split_required"] is True
    assert [Path(path).name for path in payload["split_excel_paths"]] == [
        "SP260226004-1.xlsx",
        "SP260226004-2.xlsx",
    ]


def test_cli_auto_split_mode_returns_split_payload(monkeypatch, tmp_path, capsys):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 6)

    async def fake_download(ship_no: str) -> Path:
        assert ship_no == "SP260226004"
        return excel_path

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    payload = cli.run({"ship_no": "SP260226004", "split_mode": "auto"})
    assert payload["split_mode"] == "auto"
    assert payload["box_count"] == 6
    assert payload["split_required"] is True
    assert [Path(path).name for path in payload["split_excel_paths"]] == [
        "SP260226004-1.xlsx",
        "SP260226004-2.xlsx",
    ]


def test_cli_original_split_mode_skips_split_over_five_boxes(monkeypatch, tmp_path, capsys):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 6)

    async def fake_download(ship_no: str) -> Path:
        assert ship_no == "SP260226004"
        return excel_path

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    payload = cli.run({"ship_no": "SP260226004", "split_mode": "original"})
    assert payload["split_mode"] == "original"
    assert payload["box_count"] == 6
    assert payload["split_required"] is False
    assert payload["split_excel_paths"] == []
    assert payload["split_skipped_reason"] == "用户选择使用原始装箱数据，已跳过超过 5 箱自动拆分。"
    assert not (tmp_path / "SP260226004-1.xlsx").exists()
    assert not (tmp_path / "SP260226004-2.xlsx").exists()


def test_cli_original_split_mode_without_over_limit_has_no_skip_reason(monkeypatch, tmp_path, capsys):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 4)

    async def fake_download(ship_no: str) -> Path:
        assert ship_no == "SP260226004"
        return excel_path

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    payload = cli.run({"ship_no": "SP260226004", "split_mode": "original"})
    assert payload["split_mode"] == "original"
    assert payload["box_count"] == 4
    assert payload["split_required"] is False
    assert payload["split_excel_paths"] == []
    assert "split_skipped_reason" not in payload
    assert not (tmp_path / "SP260226004-1.xlsx").exists()


def _assert_split_file(path: Path, *, expected_box_count: int) -> None:
    assert path.is_file()
    df = _read_excel(path)
    assert len(df) == expected_box_count * 2
    expected_boxes = list(range(1, expected_box_count + 1))
    assert sorted(df["箱子编号"].unique().tolist()) == expected_boxes
    assert sorted(df["箱序号"].unique().tolist()) == expected_boxes
