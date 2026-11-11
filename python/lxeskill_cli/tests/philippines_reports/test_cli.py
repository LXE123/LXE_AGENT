import json

import pytest

from lxeskill import cli
from services.commands.philippines_reports import export_run


pytestmark = pytest.mark.usefixtures("ph_workspace")
COMMAND = ["philippines", "reports"]


def _records(capfd):
    return [json.loads(line) for line in capfd.readouterr().out.splitlines() if line.strip()]


@pytest.mark.parametrize("arguments,restricted", [
    (["export"], True),
    (["export", "--warehouse", "all"], False), (["export", "--stdin-json"], False),
])
def test_cli_rejects_unauthorized_scope_and_invalid_input(arguments, restricted, ph_files, ph_online, monkeypatch, capfd):
    platform = ph_online(ph_files())
    if restricted:
        monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "mabang-tms-products-export,yacang-reports-export")
    assert cli.main([*COMMAND, *arguments]) == (cli.EXIT_ENVIRONMENT if restricted else cli.EXIT_USAGE)
    record, = _records(capfd)
    assert record["ok"] is False and record["files"] == []
    assert platform["calls"] == []
    if restricted:
        assert record["error"]["code"] == "skill_not_in_scope"


def test_export_adapter_rejects_invalid_direct_input():
    result = export_run.run({"warehouse": "VN1"})
    assert result["success"] is False and result["error"]["code"] == "invalid_arguments"
    assert result["artifacts"] == []
