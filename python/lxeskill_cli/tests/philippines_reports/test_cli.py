import json
from pathlib import Path

import pytest

from lxeskill import cli
from services.commands.philippines_reports import export_run, merge_run
from shared.workspace import artifact_root


pytestmark = pytest.mark.usefixtures("ph_workspace")
COMMAND = ["philippines", "reports"]
INPUTS = {"sales_file": "sales.xlsx", "inventory_file": "inventory.xlsx", "tms_file": "tms.xlsx"}


def _arguments(inputs):
    return [value for name, path in inputs.items() for value in (f"--{name.replace('_', '-')}", path)]


def _records(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


@pytest.mark.parametrize("action", ["merge", "export"])
def test_describe_publishes_owner_flags_and_artifacts(action, capsys):
    assert cli.main(["describe", *COMMAND, action]) == 0
    record, = _records(capsys)
    description = record["data"]
    assert description["command"] == f"philippines reports {action}"
    assert description["owner_skills"] == ["philippines-reports-export"]
    assert description["attribution_skill"] == "philippines-reports-export"
    assert description["input_modes"] == ["flags"]
    assert description["artifact_paths"] == [{"field": "artifacts[].path", "role": "deliverable"}]
    assert (set(description["input_schema"]["required"]) == set(INPUTS) if action == "merge"
            else description["input_schema"]["properties"] == {})


@pytest.mark.parametrize("arguments,restricted", [
    (["merge", *_arguments(INPUTS)], True), (["export"], True),
    (["merge", *_arguments(INPUTS), "--warehouse", "VN1"], False),
    (["export", "--warehouse", "all"], False), (["export", "--stdin-json"], False),
])
def test_cli_rejects_unauthorized_scope_and_invalid_input(arguments, restricted, monkeypatch, capsys):
    if restricted:
        monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "mabang-tms-products-export,yacang-reports-export")
    monkeypatch.setattr(cli, "execute_module_json", lambda *args, **kwargs: pytest.fail("rejected input must not execute"))
    assert cli.main([*COMMAND, *arguments]) == (cli.EXIT_ENVIRONMENT if restricted else cli.EXIT_USAGE)
    record, = _records(capsys)
    assert record["ok"] is False and record["files"] == []
    if restricted:
        assert record["error"]["code"] == "skill_not_in_scope"


@pytest.mark.parametrize("adapter, arguments", [
    (merge_run, {**INPUTS, "warehouse": "PH1"}), (merge_run, {**INPUTS, "sales_file": " "}),
    (merge_run, {**INPUTS, "tms_file": None}), (export_run, {"warehouse": "VN1"}),
])
def test_adapters_reject_invalid_direct_inputs(adapter, arguments, monkeypatch):
    function = "merge_reports" if adapter is merge_run else "export_reports"
    monkeypatch.setattr(adapter, function, lambda *args, **kwargs: pytest.fail("invalid inputs must not run"))
    result = adapter.run(arguments)
    assert result["success"] is False and result["error"]["code"] == "invalid_arguments"
    assert result["artifacts"] == []


@pytest.mark.parametrize("case", ["", "file", "flag", "corrupt"])
def test_real_merge_cli_delivers_final_pair_or_reports_invalid_source(ph_files, capsys, monkeypatch, case):
    inputs = ph_files()
    if case == "file":
        Path(inputs["tms_file"]).unlink()
    elif case == "corrupt":
        Path(inputs["tms_file"]).write_bytes(b"not an xlsx")
    if case == "flag":
        inputs.pop("tms_file")
        monkeypatch.setattr(merge_run, "merge_reports", lambda **kwargs: pytest.fail("missing source must not merge"))
    assert cli.main([*COMMAND, "merge", *_arguments(inputs)]) == (cli.EXIT_BUSINESS if case else 0)
    record, = _records(capsys)
    assert record["ok"] is (not case)
    if case:
        code = {"flag": "invalid_arguments", "file": "source_missing", "corrupt": "invalid_workbook"}[case]
        assert record["files"] == [] and record["data"]["error"]["code"] == code
        assert not list(artifact_root().rglob("*.xlsx"))
        assert not list(artifact_root().rglob(".building-*"))
        if case == "corrupt":
            assert "TmsError: 下载文件头不是 XLS/XLSX" in record["data"]["error"]["message"]
    else:
        assert len(record["files"]) == 2
        assert set(record["files"]) == {item["path"] for item in record["data"]["artifacts"]}
        assert set(record["files"]).isdisjoint(inputs.values())
        assert len(record["data"]["source_files"]) == 3
