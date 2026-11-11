from contextlib import closing
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3

from openpyxl import load_workbook
import pytest
import requests

from lxeskill import cli
from services.philippines_reports import workflow
from services.yacang.auth_state import YacangAuthState
from services.yacang.contracts import Credentials
from shared.datasets import dataset_dir


pytestmark = pytest.mark.usefixtures("ph_workspace")


def result_record(capfd):
    records = [json.loads(line) for line in capfd.readouterr().out.splitlines() if line.strip()]
    return records[-1], records[:-1]


@pytest.mark.parametrize("operation,submitted", [
    ("inventory-baseline", False), ("inventory-submit", True), ("inventory.xlsx", True),
])
def test_resume_after_login_keeps_completed_yacang_file(ph_files, ph_online, ph_rows, operation, submitted, capfd):
    platform = ph_online(ph_files())
    platform["reject"][("yacang", operation)] = (401, {"status": 0, "message": "actual expired session"})
    assert cli.main(["philippines", "reports", "export"]) == cli.EXIT_BUSINESS
    failed, _ = result_record(capfd)
    assert failed["files"] == []
    failed = failed["data"]
    assert failed["stage"] == "yacang_export"
    assert not any(call["source"] == "tms" for call in platform["calls"])

    progress_file, = dataset_dir("philippines_reports").rglob("*.json")
    progress = json.loads(progress_file.read_text(encoding="utf-8"))
    assert progress["submitted_in_run"] is submitted
    retained = Path(progress["artifacts"][0]["path"])
    original = retained.read_bytes()
    assert not any(secret in progress_file.read_text(encoding="utf-8")
                   for secret in ("yacang-test-password", "yacang-offline-token"))

    platform["reject"].clear()
    YacangAuthState(Credentials.from_environment()).save_session("yacang-offline-token")
    assert cli.main(["philippines", "reports", "export", "--resume-id", failed["resume_id"]]) == 0
    record, _ = result_record(capfd)
    result = record["data"]
    assert len(record["files"]) == len(result["artifacts"]) == 2
    sales_row, inventory_row = (ph_rows(item)[0] for item in result["artifacts"])
    assert (sales_row["7天销量"], inventory_row["可用库存"]) == (12, 130)
    assert retained.read_bytes() == original
    assert sum(call["operation"] == "sales-submit" for call in platform["calls"]) == 1
    assert not progress_file.exists()
    with sqlite3.connect(os.environ["LXE_SQLITE_DB_PATH"]) as connection:
        assert connection.execute("SELECT COUNT(*) FROM yacang_submissions").fetchone()[0] == 0


def test_retry_tms_keeps_both_yacang_files(ph_files, ph_online, capfd):
    platform = ph_online(ph_files())
    platform["reject"][("tms", "login")] = (429, {"message": "actual TMS rate limit"})
    assert cli.main(["philippines", "reports", "export"]) == cli.EXIT_BUSINESS
    failed, _ = result_record(capfd)
    assert failed["files"] == [] and failed["data"]["stage"] == "tms_export"
    yacang_calls = [call for call in platform["calls"] if call["source"] == "yacang"]
    retained = {Path(item["path"]): Path(item["path"]).read_bytes()
                for item in failed["data"]["source_exports"][0]["artifacts"]}

    platform["reject"].clear()
    assert cli.main(["philippines", "reports", "export", "--resume-id", failed["data"]["resume_id"]]) == 0
    record, _ = result_record(capfd)
    assert len(record["files"]) == 2 and record["ok"]
    assert [call for call in platform["calls"] if call["source"] == "yacang"] == yacang_calls
    assert {path: path.read_bytes() for path in retained} == retained


def test_cli_runs_both_real_workflows_and_delivers_only_merged_pair(ph_files, ph_online, ph_rows, capfd):
    paths = ph_files()
    ph_online(paths)
    assert cli.main(["philippines", "reports", "export"]) == 0
    record, events = result_record(capfd)
    result = record["data"]
    assert record["ok"] and result["success"] and result["status"] == "completed"
    assert len(record["files"]) == 2
    assert set(record["files"]) == {item["path"] for item in result["artifacts"]}
    assert set(record["files"]).isdisjoint(paths.values())
    for source in result["source_files"]:
        assert source["sha256"] == hashlib.sha256(Path(source["path"]).read_bytes()).hexdigest()
        assert source["path"] not in record["files"]
    sales, inventory = (ph_rows(item)[0] for item in result["artifacts"])
    assert (sales["7天销量"], sales["可用"], inventory["可用库存"]) == (12, 130, 130)
    assert all(event["type"] == "progress" for event in events)
    stages = [event.get("stage") for event in events]
    assert stages.index("yacang_export") < stages.index("tms_export") < stages.index("merge")
    assert all(secret not in json.dumps(record) for secret in
               ("yacang-test-password", "tms-test-password", "yacang-offline-token", "tms-offline-token"))


def test_start_date_survives_midnight_during_export(ph_files, ph_online, monkeypatch):
    ph_online(ph_files())
    clock = {"day": 5}

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 11, clock["day"], tzinfo=tz)

    monkeypatch.setattr(workflow, "datetime", Clock)

    def on_event(event):
        if event.get("stage") == "tms_export":
            clock["day"] = 6

    result = workflow.export_reports(on_event)
    assert result["success"], result
    assert result["report_date"] == "2026-11-05"
    assert all(Path(item["path"]).name.endswith("-2026年11月05日.xlsx") for item in result["artifacts"])


@pytest.mark.parametrize("source,operation,status,code", [
    ("yacang", "sales-submit", 429, "rate_limited"),
    ("tms", "login", 429, "http_429"),
    ("tms", "login", None, "network_error"),
])
def test_failed_http_export_preserves_diagnostic_and_never_delivers_pair(ph_files, ph_online, source, operation, status, code, capfd):
    platform = ph_online(ph_files())
    secrets = ("yacang-test-account", "yacang-test-password", "tms-test-account", "tms-test-password")
    message = "actual upstream response 503 " + " ".join(secrets)
    platform["reject"][(source, operation)] = (
        (status, {"status": 0, "message": message}) if status
        else requests.ConnectionError(message)
    )
    assert cli.main(["philippines", "reports", "export"]) == cli.EXIT_BUSINESS
    record, _ = result_record(capfd)
    result = record["data"]
    assert not record["ok"] and record["files"] == [] and result["artifacts"] == []
    assert result["error"]["code"] == code and "actual upstream response 503" in result["error"]["message"]
    assert "actual upstream response 503" in record["error"]["message"]
    assert all(secret not in json.dumps(record, ensure_ascii=False) for secret in secrets)
    assert "[REDACTED]" in result["error"]["message"]
    assert not list(dataset_dir("philippines_reports").rglob("*.xlsx"))
    if source == "yacang":
        assert not any(call["source"] == "tms" for call in platform["calls"])


def test_invalid_tms_api_number_blocks_philippines_pair(ph_files, ph_online):
    platform = ph_online(ph_files())
    platform["tms_records"][0]["stockQuantity"] = "bad"
    result = workflow.export_reports()
    assert not result["success"] and result["stage"] == "tms_export"
    assert result["artifacts"] == []
    assert "stockQuantity" in result["error"]["message"] and "bad" in result["error"]["message"]
    assert not list(dataset_dir("philippines_reports").rglob("*.xlsx"))


@pytest.mark.parametrize("source", ["yacang", "tms"])
def test_upstream_warehouse_validation_blocks_wrong_sources(ph_files, ph_online, source):
    paths = ph_files()
    platform = ph_online(paths)
    if source == "yacang":
        with closing(load_workbook(paths["inventory_file"])) as book:
            book.active["E2"] = "VN8806"
            book.save(paths["inventory_file"])
    else:
        platform["tms_records"][0]["warehouseId"] = 12831
    result = workflow.export_reports()
    assert not result["success"] and result["artifacts"] == []
    assert result["stage"] == ("yacang_export" if source == "yacang" else "tms_export")
    assert "VN8806" in result["error"]["message"] if source == "yacang" else "12831" in result["error"]["message"]
    assert not list(dataset_dir("philippines_reports").rglob("*.xlsx"))


@pytest.mark.parametrize("source", ["yacang", "tms"])
def test_changed_source_row_count_prevents_pair_publication(ph_files, ph_online, source):
    ph_online(ph_files())

    def change_file(event):
        if event.get("stage") != "merge":
            return
        root = dataset_dir("yacang_exports" if source == "yacang" else "mabang_tms_exports")
        prefix = "雅仓-当前库存" if source == "yacang" else "马帮TMS-商品-"
        path, = (path for path in root.rglob("*.xlsx") if path.name.startswith(prefix))
        with closing(load_workbook(path)) as book:
            row = [cell.value for cell in book.active[2]]
            row[1 if source == "yacang" else 0] = "another-sku"
            book.active.append(row)
            book.save(path)

    result = workflow.export_reports(change_file)
    assert not result["success"] and result["stage"] == "merge"
    assert result["error"]["code"] == "source_count_mismatch" and result["artifacts"] == []
    assert not list(dataset_dir("philippines_reports").rglob("*.xlsx"))


def test_confirmed_empty_tms_still_generates_yacang_reports(ph_files, ph_online, ph_rows):
    platform = ph_online(ph_files())
    platform["tms_records"].clear()
    result = workflow.export_reports()
    assert result["success"] and result["tms_empty"] and len(result["artifacts"]) == 2, result
    assert result["statistics"]["tms_rows"] == 0
    assert ph_rows(result["artifacts"][1])[0]["可用库存"] == 100
    assert ph_rows(result["artifacts"][0])[0]["7天销量"] == 10
    assert not any(call["operation"] == "exportStockwarehouse" for call in platform["calls"])
    with closing(load_workbook(result["artifacts"][0]["path"])) as book:
        assert book.worksheets[0].max_column == book.worksheets[1].max_column == 15
        assert book.worksheets[1]["N2"].value == 100
