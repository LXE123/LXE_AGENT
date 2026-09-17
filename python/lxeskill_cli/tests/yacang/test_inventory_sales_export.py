from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import pytest
from openpyxl import Workbook

from services.agent_cli.yacang.export_inventory_sales import run
from services.yacang.errors import YacangError, safe_remote_detail
from services.yacang.inventory_sales_export import (
    EXPECTED_HEADERS,
    ExportRequest,
    WAREHOUSES,
    export_inventory_sales,
    task_matches_request,
    validate_workbook,
    YacangRiskController,
)
from services.yacang.exports.inventory_sales import export_inventory_sales_requests
from services.yacang.submission import MemorySubmissionStore, submission_key


def _write_xlsx(path: Path, warehouse: str) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(EXPECTED_HEADERS)
    sheet.append(("SKU-1", "商品", warehouse, 1, 2, 3, 4, 5, 6, 10, 0, 0, 0, 10, 0, "2026-09-01"))
    workbook.save(path)
    workbook.close()


class FakeClient:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.login_calls: list[tuple[str, str]] = []
        self.submissions: list[int] = []
        self.current: int | None = None

    def login(self, mobile: str, password: str) -> None:
        self.login_calls.append((mobile, password))

    def list_downloads(self, *, limit: int = 50) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = [{"id": "old", "name": "库存动销导出", "type": "10"}]
        if self.current is not None:
            rows.insert(0, {
                "id": f"new-{self.current}",
                "name": "库存动销导出",
                "type": "10",
                "path": f"https://oss-accelerate.seaya.cn/test/{self.current}.xlsx",
                "param_where": json.dumps([
                    ["warehouse_id", "in", [str(self.current)]],
                    ["create_time", ">=", 1788192000],
                    ["create_time", "<", 1789315200],
                ]),
            })
        return rows

    def create_inventory_sales_export(self, *, warehouse_id: int, start_date: str, end_date: str) -> str:
        assert start_date == "2026-09-01"
        assert end_date == "2026-09-13"
        self.current = warehouse_id
        self.submissions.append(warehouse_id)
        return f"request-{warehouse_id}"

    def download_xlsx(self, url: str, destination: Path) -> None:
        warehouse = next(code for code, warehouse_id in WAREHOUSES if str(warehouse_id) in url)
        _write_xlsx(destination, warehouse)


class FailingFakeClient(FakeClient):
    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.submit_errors: dict[int, Exception] = {}
        self.download_errors: dict[int, Exception] = {}

    def create_inventory_sales_export(self, *, warehouse_id: int, start_date: str, end_date: str) -> str:
        error = self.submit_errors.get(warehouse_id)
        if error is not None:
            raise error
        return super().create_inventory_sales_export(
            warehouse_id=warehouse_id,
            start_date=start_date,
            end_date=end_date,
        )

    def download_xlsx(self, url: str, destination: Path) -> None:
        warehouse_id = int(url.rsplit("/", 1)[-1].removesuffix(".xlsx"))
        error = self.download_errors.get(warehouse_id)
        if error is not None:
            raise error
        super().download_xlsx(url, destination)


def test_task_match_uses_param_where_not_outer_warehouse_id() -> None:
    request = ExportRequest("MY8801", 26, "2026-09-01", "2026-09-13")
    task = {
        "name": "库存动销导出",
        "type": "10",
        "warehouse_id": "0",
        "param_where": (
            '[["warehouse_id","in",["26"]],'
            '["create_time",">=",1788192000],["create_time","<",1789315200]]'
        ),
    }
    assert task_matches_request(task, request)
    assert not task_matches_request(task, ExportRequest("PH8805", 46, "2026-09-01", "2026-09-13"))
    assert not task_matches_request(task, ExportRequest("MY8801", 26, "2026-09-02", "2026-09-13"))


def test_risk_controller_rejects_unknown_and_duplicate_warehouse_writes() -> None:
    risk = YacangRiskController(sleep=lambda _seconds: None)
    request = ExportRequest("MY8801", 26, "2026-09-01", "2026-09-13")
    risk.before_submission(request)
    with pytest.raises(YacangError, match="已提交相同任务"):
        risk.before_submission(request)
    risk.before_submission(ExportRequest("MY8801", 26, "2026-08-25", "2026-09-01"))
    with pytest.raises(YacangError, match="未授权仓库映射"):
        YacangRiskController().before_submission(
            ExportRequest("UNKNOWN", 999, "2026-09-01", "2026-09-13")
        )


def test_export_logs_in_once_and_exports_four_warehouses_serially(tmp_path: Path) -> None:
    client = FakeClient(tmp_path)
    result = export_inventory_sales(
        start_date="2026-09-01",
        end_date="2026-09-13",
        mobile="account",
        password="secret",
        output_dir=tmp_path,
        cache_max_age_seconds=0,
        client=client,  # type: ignore[arg-type]
        sleep=lambda _seconds: None,
    )
    assert result["success"] is True
    assert result["sales_window_days"] == 15
    assert result["warehouse_count"] == 4
    assert client.login_calls == [("account", "secret")]
    assert client.submissions == [26, 46, 47, 80]
    assert [item["warehouse"] for item in result["exports"]] == ["MY8801", "PH8805", "TH8802", "VN8806"]
    assert all(Path(path).is_file() for path in result["xlsx_paths"])


def test_fresh_valid_files_are_reused_without_login(tmp_path: Path) -> None:
    for warehouse, _warehouse_id in WAREHOUSES:
        _write_xlsx(tmp_path / f"yacang_inventory_sales_{warehouse}_2026-09-01_2026-09-13.xlsx", warehouse)
    client = FakeClient(tmp_path)
    result = export_inventory_sales(
        start_date="2026-09-01",
        end_date="2026-09-13",
        mobile="account",
        password="secret",
        output_dir=tmp_path,
        cache_max_age_seconds=300,
        client=client,  # type: ignore[arg-type]
    )
    assert client.login_calls == []
    assert client.submissions == []
    assert {item["source"] for item in result["exports"]} == {"cache"}


def test_single_warehouse_download_failure_keeps_successes_and_continues(tmp_path: Path) -> None:
    client = FailingFakeClient(tmp_path)
    client.download_errors[46] = YacangError(
        "下载 XLSX", "fixture network failure", code="XLSX_DOWNLOAD_NETWORK_ERROR"
    )

    result = export_inventory_sales(
        start_date="2026-09-01",
        end_date="2026-09-13",
        mobile="account",
        password="secret",
        output_dir=tmp_path,
        cache_max_age_seconds=0,
        client=client,  # type: ignore[arg-type]
        sleep=lambda _seconds: None,
    )

    assert result["overall_status"] == "partial_success"
    assert result["success_count"] == 3
    assert result["failed_count"] == 1
    assert result["skipped_count"] == 0
    assert client.submissions == [26, 46, 47, 80]
    assert [item["status"] for item in result["exports"]] == [
        "success", "failed", "success", "success",
    ]
    assert len(result["xlsx_paths"]) == 3


def test_global_403_stops_later_warehouses_and_preserves_prior_success(tmp_path: Path) -> None:
    client = FailingFakeClient(tmp_path)
    client.submit_errors[46] = YacangError(
        "提交库存动销导出",
        "HTTP 403",
        code="YACANG_FORBIDDEN",
        http_status=403,
        scope="global",
    )

    result = export_inventory_sales(
        start_date="2026-09-01",
        end_date="2026-09-13",
        mobile="account",
        password="secret",
        output_dir=tmp_path,
        cache_max_age_seconds=0,
        client=client,  # type: ignore[arg-type]
        sleep=lambda _seconds: None,
    )

    assert result["overall_status"] == "partial_success"
    assert [item["status"] for item in result["exports"]] == [
        "success", "failed", "skipped", "skipped",
    ]
    assert client.submissions == [26]
    assert len(result["xlsx_paths"]) == 1


def test_submit_unknown_stops_batch_and_is_not_retried(tmp_path: Path) -> None:
    client = FailingFakeClient(tmp_path)
    client.submit_errors[46] = YacangError(
        "提交库存动销导出",
        "Timeout",
        code="EXPORT_SUBMIT_UNKNOWN",
        error_type="Timeout",
        scope="global",
    )

    result = export_inventory_sales(
        start_date="2026-09-01",
        end_date="2026-09-13",
        mobile="account",
        password="secret",
        output_dir=tmp_path,
        cache_max_age_seconds=0,
        client=client,  # type: ignore[arg-type]
        sleep=lambda _seconds: None,
    )

    assert [item["status"] for item in result["exports"]] == [
        "success", "submit_unknown", "skipped", "skipped",
    ]
    assert client.submissions == [26]


def test_existing_submission_marker_polls_existing_task_without_resubmit(tmp_path: Path) -> None:
    request = ExportRequest("MY8801", 26, "2026-09-01", "2026-09-13")
    key = submission_key(
        business_key=request.business_key,
        warehouse_code=request.warehouse_code,
        start_date=request.start_date,
        end_date=request.end_date,
    )
    store = MemorySubmissionStore()
    store.acquire(key, {"old"})
    client = FakeClient(tmp_path)
    client.current = 26

    (result,) = export_inventory_sales_requests(
        [request],
        dataset_id="yacang_inventory_sales",
        mobile="account",
        password="secret",
        output_dir=tmp_path,
        cache_max_age_seconds=0,
        client=client,  # type: ignore[arg-type]
        submission_store=store,
        sleep=lambda _seconds: None,
    )

    assert result["status"] == "success"
    assert client.submissions == []
    assert store.records == {}


def test_rerun_reuses_successful_cache_and_submits_only_missing_warehouses(tmp_path: Path) -> None:
    _write_xlsx(
        tmp_path / "yacang_inventory_sales_MY8801_2026-09-01_2026-09-13.xlsx",
        "MY8801",
    )
    client = FakeClient(tmp_path)
    result = export_inventory_sales(
        start_date="2026-09-01",
        end_date="2026-09-13",
        mobile="account",
        password="secret",
        output_dir=tmp_path,
        cache_max_age_seconds=300,
        client=client,  # type: ignore[arg-type]
        sleep=lambda _seconds: None,
    )

    assert client.submissions == [46, 47, 80]
    assert result["success_count"] == 4
    assert result["exports"][0]["source"] == "cache"


def test_failed_refresh_preserves_previous_valid_artifact(tmp_path: Path) -> None:
    request = ExportRequest("MY8801", 26, "2026-09-01", "2026-09-13")
    existing = tmp_path / request.filename
    _write_xlsx(existing, "MY8801")
    stale = time.time() - 3_600
    os.utime(existing, (stale, stale))
    client = FailingFakeClient(tmp_path)
    client.download_errors[26] = YacangError(
        "下载 XLSX", "fixture failure", code="XLSX_DOWNLOAD_NETWORK_ERROR"
    )

    (result,) = export_inventory_sales_requests(
        [request],
        dataset_id="yacang_inventory_sales",
        mobile="account",
        password="secret",
        output_dir=tmp_path,
        cache_max_age_seconds=300,
        client=client,  # type: ignore[arg-type]
        sleep=lambda _seconds: None,
    )

    assert result["status"] == "failed"
    assert existing.is_file()
    assert validate_workbook(existing, warehouse_code="MY8801") == 1
    assert list(tmp_path.glob("*.pending.xlsx")) == []


def test_workbook_rejects_cross_warehouse_rows(tmp_path: Path) -> None:
    path = tmp_path / "wrong.xlsx"
    _write_xlsx(path, "TH8802")
    with pytest.raises(YacangError, match="其他仓库"):
        validate_workbook(path, warehouse_code="MY8801")


def test_error_detail_redacts_credentials_and_captcha() -> None:
    detail = safe_remote_detail({
        "message": "invalid",
        "token": "secret-token",
        "nested": {"password": "secret-password", "captcha": "data:image/jpeg;base64,secret"},
    })
    assert "invalid" in detail
    assert "secret-token" not in detail
    assert "secret-password" not in detail
    assert "base64" not in detail


def test_cli_failure_is_factual_and_does_not_echo_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LXE_YACANG_MOBILE", raising=False)
    monkeypatch.delenv("LXE_YACANG_PASSWORD", raising=False)
    result = run({"start_date": "2026-09-01", "end_date": "2026-09-13"})
    assert result["success"] is False
    assert "缺少雅仓账号或密码" in result["exception"]
    assert "password" not in result
