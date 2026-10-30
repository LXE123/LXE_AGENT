"""Public discovery, scope and one representative V2 CLI handoff; no workbook re-testing."""
from __future__ import annotations

import json
from unittest.mock import Mock
import pytest
from lxeskill import cli as lxeskill
from lxeskill.business import load_catalog
from services.commands.mabang import generate_replenishment_v2 as adapter
from services.mabang.amazon.fba.replenishment_v2_workbook import ReplenishmentV2WorkbookResult

COMMAND = ["replenish", "v2", "generate"]
WORKFLOW_SKILL = "replenishment-workflow-map"
INPUTS = dict(store_name="Amazon-Test", msku_source_xlsx_path="source.xlsx",
              shenzhen_inventory_report_xlsx_path="inventory.xlsx", unlinked_shipments_snapshot_path="snapshot.xlsx")


@pytest.fixture(autouse=True)
def isolated_scope(tmp_path, monkeypatch):
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", WORKFLOW_SKILL)
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))


def test_v2_discovery_has_one_owner_and_required_files(capsys):
    assert lxeskill.main(["describe", *COMMAND]) == 0
    record = json.loads(capsys.readouterr().out)
    assert record["data"]["owner_skills"] == [WORKFLOW_SKILL]
    assert record["data"]["input_schema"]["required"] == list(INPUTS)
    assert lxeskill.main(["list"]) == 0
    commands = {entry["command"] for entry in json.loads(capsys.readouterr().out)["data"]["commands"]}
    assert " ".join(COMMAND) in commands and "replenish calculate" not in commands
    assert load_catalog()["mabang_calculate_store_msku_replenishment"]["owner_skills"] == ["replenishment-calculate"]


@pytest.mark.parametrize("scope,command", [
    ("replenishment-calculate", COMMAND), (WORKFLOW_SKILL, ["replenish", "calculate"]),
])
def test_versions_keep_separate_calculation_scope(scope, command, monkeypatch, capsys):
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", scope)
    assert lxeskill.main(command) == lxeskill.EXIT_ENVIRONMENT
    terminal = json.loads(capsys.readouterr().out)
    assert terminal["error"]["code"] == "skill_not_in_scope" and terminal["files"] == []


@pytest.mark.parametrize("flags,enabled,days", [([], None, None), (["--peak-boost-enabled", "--peak-boost-days", "20"], True, 20),
                                                        (["--peak-boost-enabled=false"], False, None)])
def test_v2_cli_forwards_files_and_request_settings(tmp_path, monkeypatch, capsys, flags, enabled, days):
    output = tmp_path / ".lxeagent/artifacts/replenish/result.xlsx"
    output.parent.mkdir(parents=True)
    output.touch()
    result = ReplenishmentV2WorkbookResult("Amazon-Test", "202610131000", str(output), 1, 0, ())
    generate = Mock(return_value=result)
    monkeypatch.setattr(adapter, "generate_replenishment_v2", generate)
    args = [*COMMAND, *(part for key, value in INPUTS.items() for part in ("--" + key.replace("_", "-"), value)), *flags]
    assert lxeskill.main(args) == 0
    terminal = json.loads(capsys.readouterr().out)
    assert terminal["ok"] is True and terminal["files"] == [str(output)]
    generate.assert_called_once_with("Amazon-Test", **{key: value for key, value in INPUTS.items() if key != "store_name"},
                                     peak_boost_enabled=enabled, peak_boost_days=days)


def test_v2_cli_preserves_service_failure(monkeypatch, capsys):
    monkeypatch.setattr(adapter, "generate_replenishment_v2", Mock(side_effect=ValueError("fixture source batch mismatch")))
    args = [*COMMAND, *(part for key, value in INPUTS.items() for part in ("--" + key.replace("_", "-"), value))]
    assert lxeskill.main(args) == lxeskill.EXIT_BUSINESS
    terminal = json.loads(capsys.readouterr().out)
    assert terminal["ok"] is False and terminal["files"] == []
    assert "fixture source batch mismatch" in terminal["error"]["message"]
