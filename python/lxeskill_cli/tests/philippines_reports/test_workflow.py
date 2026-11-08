from contextlib import closing
from datetime import date
import hashlib
import json
from pathlib import Path
from unittest.mock import ANY, Mock, call

from openpyxl import load_workbook
import pytest

from lxeskill import cli
from services.philippines_reports import workflow
from services.mabang_tms.workflow import run_with_events as run_tms_export
from services.yacang.validation import INVENTORY_SALES_HEADERS
from shared.workspace import artifact_root


pytestmark = pytest.mark.usefixtures("ph_workspace")


def test_online_export_uses_fixed_sources_and_start_date_across_midnight(ph_files, ph_online, ph_rows, monkeypatch, capsys):
    paths = ph_files()
    yacang, tms, yacang_mock, tms_mock = ph_online(paths)
    clock = {"today": date(2026, 11, 5)}
    monkeypatch.setattr(workflow, "_today", lambda: clock["today"])
    calls = Mock()
    calls.attach_mock(yacang_mock, "yacang")
    calls.attach_mock(tms_mock, "tms")

    def export_yacang(arguments, *, require_fresh):
        clock["today"] = date(2026, 11, 6)
        return yacang

    def export_tms(arguments, on_event):
        on_event({"message": "sample batch complete"})
        return tms

    yacang_mock.side_effect = export_yacang
    tms_mock.side_effect = export_tms
    assert cli.main(["philippines", "reports", "export"]) == 0
    records = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    record, events = records[-1], records[:-1]
    result = record["data"]
    assert result["success"] is True and len(result["artifacts"]) == 2, result
    assert record["ok"] is True and record["type"] == "result"
    assert set(record["files"]) == {item["path"] for item in result["artifacts"]}
    assert set(record["files"]).isdisjoint(paths.values())
    sales_source = next(item for item in result["source_files"] if item["report"] == "inventory-sales" and item["source"] == "yacang")
    assert sales_source["sha256"] == hashlib.sha256(Path(paths["sales_file"]).read_bytes()).hexdigest()
    sales, inventory = (ph_rows(item)[0] for item in result["artifacts"])
    assert (sales["7天销量"], sales["可用"], inventory["可用库存"]) == (12, 130, 130)
    assert calls.mock_calls == [
        call.yacang({"params": {"reports": ["inventory-sales", "inventory-current-snapshot"], "warehouses": ["PH8805"]}}, require_fresh=True),
        call.tms({"warehouse": "PH1"}, ANY),
    ]
    assert all(event["type"] == "progress" for event in events)
    assert any(event.get("message") == "sample batch complete" for event in events)
    assert [event.get("stage") for event in events if event.get("stage")] == ["yacang_export", "tms_export", "merge"]
    assert result["report_date"] == "2026-11-05" and result["timezone"] == "Asia/Shanghai"
    assert all(Path(item["path"]).name.endswith("-2026年11月05日.xlsx") for item in result["artifacts"])


@pytest.mark.parametrize("failed_source,message,code", [
    ("yacang", "actual upstream response 429", "rate_limited"),
    ("tms", "actual upstream response 429", "rate_limited"),
    ("exception", "actual source error 503", "philippines_reports_failed"),
])
def test_failed_export_preserves_diagnostic_without_merging(ph_files, ph_online, monkeypatch, failed_source, message, code, capsys):
    paths = ph_files()
    yacang, tms, _, tms_mock = ph_online(paths)
    secrets = {"LXE_YACANG_MOBILE": "yacang-test-account", "LXE_YACANG_PASSWORD": "yacang-test-password",
               "LXE_MABANG_TMS_ACCOUNT": "tms-test-account", "LXE_MABANG_TMS_PASSWORD": "tms-test-password"}
    for name, value in secrets.items():
        monkeypatch.setenv(name, value)
    diagnostic = message + " " + " ".join(secrets.values())
    if failed_source == "exception":
        tms_mock.side_effect = RuntimeError(diagnostic)
    else:
        (yacang if failed_source == "yacang" else tms).update(
            success=False, status="partial_success", error={"code": code, "message": diagnostic})
    monkeypatch.setattr(workflow, "build_reports", lambda **kwargs: pytest.fail("partial export must not merge"))
    assert cli.main(["philippines", "reports", "export"]) == cli.EXIT_BUSINESS
    record = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()][-1]
    result = record["data"]
    assert record["ok"] is False and record["files"] == []
    assert result["success"] is False and result["artifacts"] == []
    assert result["error"]["code"] == code and message in result["error"]["message"]
    assert message in record["error"]["message"]
    assert all(secret not in json.dumps(record, ensure_ascii=False) for secret in secrets.values())
    assert "[REDACTED]" in result["error"]["message"]
    assert paths["sales_file"] in json.dumps(result["source_exports"], ensure_ascii=False)
    assert not list(artifact_root().rglob("*.xlsx"))
    if failed_source == "yacang":
        tms_mock.assert_not_called()


def test_invalid_tms_api_number_blocks_philippines_pair(ph_files, ph_online, tmp_path, monkeypatch):
    paths = ph_files()
    ph_online(paths)
    client = Mock()
    client.list_page.return_value = {"code": "200", "totalNum": 1, "datas": [{
        "id": 1, "stockSku": "001", "warehouseId": 12107, "warehouseName": "菲律宾PH1仓",
        "stockQuantity": "bad", "sale1": 1, "sale2": 3, "sale3": 4}]}
    client.export.return_value = "https://tms-cos.mabangerp.com/test"
    client.download.return_value = Path(paths["tms_file"]).read_bytes()
    client.safe.side_effect = str
    monkeypatch.setenv("LXE_MABANG_TMS_ACCOUNT", "account")
    monkeypatch.setenv("LXE_MABANG_TMS_PASSWORD", "password")
    monkeypatch.setattr(workflow.tms_workflow, "run_with_events", run_tms_export)
    monkeypatch.setattr(workflow.tms_workflow, "TmsClient", lambda *args: client)
    monkeypatch.setattr(workflow.tms_workflow, "dataset_dir", lambda *parts: tmp_path.joinpath("tms", *parts[1:]))
    result = workflow.export_reports()
    assert result["success"] is False and result["stage"] == "tms_export"
    assert result["artifacts"] == []
    assert "stockQuantity" in result["error"]["message"] and "bad" in result["error"]["message"]
    assert not list(artifact_root().rglob("*.xlsx"))


@pytest.mark.parametrize("source, mutate, stage, code", [
    ("yacang", lambda x: x["artifacts"].pop(), "yacang_export", "source_metadata_invalid"),
    ("yacang", lambda x: x["artifacts"][0].update(warehouse="VN8806"), "yacang_export", "source_metadata_invalid"),
    ("yacang", lambda x: x["artifacts"][0].update(created_date={"start_date": "2026-10-01", "end_date": "2026-10-30"}),
     "yacang_export", "source_metadata_invalid"),
    ("tms", lambda x: x.update(warehouse="VN1", warehouse_id=12831), "tms_export", "source_metadata_invalid"),
    ("tms", lambda x: x.update(artifacts=[]), "tms_export", "source_metadata_invalid"),
    ("tms", lambda x: x.pop("source_row_count"), "tms_export", "source_metadata_invalid"),
    ("tms", lambda x: x.update(row_count=99, distinct_skus=99, source_row_count=99,
                              artifacts=[{**x["artifacts"][0], "row_count": 99}]), "merge", "source_count_mismatch"),
    ("yacang", lambda x: x["artifacts"][0].update(row_count=99), "merge", "source_count_mismatch"),
])
def test_invalid_export_contract_prevents_publication(ph_files, ph_online, source, mutate, stage, code):
    yacang, tms, _, tms_mock = ph_online(ph_files())
    mutate(yacang if source == "yacang" else tms)
    result = workflow.export_reports()
    assert result["success"] is False and result["artifacts"] == []
    assert result["stage"] == stage and result["error"]["code"] == code
    assert result["error"]["message"]
    assert not list(artifact_root().rglob("*.xlsx"))
    if stage == "yacang_export":
        tms_mock.assert_not_called()


def test_confirmed_empty_tms_still_generates_yacang_reports(ph_files, ph_online, ph_rows):
    _, tms, _, _ = ph_online(ph_files(sales_headers=INVENTORY_SALES_HEADERS))
    tms.update(reported_total=0, read_unique_ids=0, exported_unique_ids=0, source_row_count=0,
               row_count=0, distinct_skus=0, artifacts=[])
    result = workflow.export_reports()
    assert result["success"] is True and len(result["artifacts"]) == 2, result
    assert result["statistics"]["tms_rows"] == 0
    assert result["field_mappings"] == {"inventory": {}, "inventory-sales": {}}
    assert ph_rows(result["artifacts"][1])[0]["可用库存"] == 100
    assert ph_rows(result["artifacts"][0])[0]["7天销量"] == 10
    with closing(load_workbook(result["artifacts"][0]["path"])) as book:
        assert book.worksheets[0].max_column == 16 and book.worksheets[1].max_column == 15
        assert book.worksheets[1]["N2"].value == 100
