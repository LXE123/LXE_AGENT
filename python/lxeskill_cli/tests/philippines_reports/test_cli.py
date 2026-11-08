import json

import pytest

from lxeskill import cli
from services.commands.philippines_reports import export_run


pytestmark = pytest.mark.usefixtures("ph_workspace")
COMMAND = ["philippines", "reports"]


def _records(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


def test_export_is_the_only_philippines_command(capsys):
    assert cli.main(["describe", *COMMAND, "export"]) == 0
    record, = _records(capsys)
    description = record["data"]
    assert description["command"] == "philippines reports export"
    assert description["owner_skills"] == ["philippines-reports-export"]
    assert description["attribution_skill"] == "philippines-reports-export"
    assert description["input_modes"] == ["flags"]
    assert description["artifact_paths"] == [{"field": "artifacts[].path", "role": "deliverable"}]
    assert description["input_schema"]["properties"] == {}
    assert cli.main(["list"]) == 0
    record, = _records(capsys)
    commands = {item["command"] for item in record["data"]["commands"]}
    assert {command for command in commands if command.startswith("philippines reports ")} == {
        "philippines reports export",
    }


@pytest.mark.parametrize("arguments,restricted", [
    (["export"], True),
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


def test_export_adapter_rejects_invalid_direct_input(monkeypatch):
    monkeypatch.setattr(export_run, "export_reports", lambda *args, **kwargs: pytest.fail("invalid inputs must not run"))
    result = export_run.run({"warehouse": "VN1"})
    assert result["success"] is False and result["error"]["code"] == "invalid_arguments"
    assert result["artifacts"] == []
