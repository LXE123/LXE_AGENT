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


def test_local_merge_snapshots_and_publishes_distinct_verified_pairs(ph_files, ph_rows, monkeypatch):
    paths = ph_files()
    originals = {path: Path(path).read_bytes() for path in paths.values()}
    first = workflow.merge_reports(**paths)
    assert first["success"] is True and first["validation"]["status"] == "passed", first
    provenance = {item["path"]: item for item in first["source_files"]}
    assert set(provenance) == set(originals)
    for path, content in originals.items():
        assert Path(path).read_bytes() == content
        assert provenance[path]["sha256"] == hashlib.sha256(content).hexdigest()
    build_reports = workflow.build_reports

    def change_original_then_build(**arguments):
        assert Path(arguments["inventory_path"]) != Path(paths["inventory_file"])
        assert Path(arguments["inventory_path"]).read_bytes() == originals[paths["inventory_file"]]
        book = load_workbook(paths["inventory_file"])
        book.active["M2"] = 999
        book.save(paths["inventory_file"])
        book.close()
        return build_reports(**arguments)

    monkeypatch.setattr(workflow, "build_reports", change_original_then_build)
    second = workflow.merge_reports(**paths)
    assert second["success"] is True and second["status"] == "completed", second
    assert ph_rows(second["artifacts"][1])[0]["可用库存"] == 130
    assert second["source_files"] == first["source_files"]
    pairs = [{Path(item["path"]) for item in result["artifacts"]} for result in (first, second)]
    assert all(len(pair) == 2 and len({path.parent for path in pair}) == 1 for pair in pairs)
    assert pairs[0].isdisjoint(pairs[1])
    assert {path.name for path in pairs[0]} == {path.name for path in pairs[1]}
    assert all(path.is_file() and path.is_relative_to(artifact_root()) for path in pairs[0] | pairs[1])


@pytest.mark.parametrize("failure", ["copy", "build", "publish"])
def test_merge_failure_cleans_all_staging_and_never_publishes(ph_files, monkeypatch, failure):
    paths = ph_files()
    if failure == "copy":
        copyfile = workflow.shutil.copyfile

        def copy_then_change_source(source, target):
            copied = copyfile(source, target)
            Path(source).write_bytes(Path(source).read_bytes() + b"changed during snapshot")
            return copied

        monkeypatch.setattr(workflow.shutil, "copyfile", copy_then_change_source)
        monkeypatch.setattr(workflow, "build_reports", lambda **kwargs: pytest.fail("changed source must not build"))
    elif failure == "build":
        def fail_after_first_file(**arguments):
            (Path(arguments["output_dir"]) / "first.xlsx").write_bytes(b"unfinished output")
            raise OSError("observed workbook write failure")

        monkeypatch.setattr(workflow, "build_reports", fail_after_first_file)
    else:
        monkeypatch.setattr(Path, "rename", Mock(side_effect=PermissionError("observed publication access denied")))
    result = workflow.merge_reports(**paths)
    assert result["success"] is False and result["artifacts"] == []
    if failure == "copy":
        assert result["error"]["code"] == "source_changed"
    else:
        assert ("observed workbook write failure" if failure == "build" else
                "observed publication access denied") in result["error"]["message"]
    assert list(workflow.dataset_dir("philippines_reports").iterdir()) == []


def test_online_export_uses_fixed_sources_and_start_date_across_midnight(ph_files, ph_online, monkeypatch, capsys):
    paths = ph_files()
    yacang, tms, yacang_mock, tms_mock = ph_online(paths)
    clock = {"today": date(2026, 11, 5)}
    monkeypatch.setattr(workflow, "_today", lambda: clock["today"])
    calls = Mock()
    calls.attach_mock(yacang_mock, "yacang")
    calls.attach_mock(tms_mock, "tms")

    def export_yacang(arguments):
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
    assert calls.mock_calls == [
        call.yacang({"params": {"reports": ["inventory-sales", "inventory-current-snapshot"], "warehouses": ["PH8805"]}}),
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
    ("tms", lambda x: x.update(exported_unique_ids=0), "tms_export", "source_export_incomplete"),
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
