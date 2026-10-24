from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from lxeskill import cli as lxeskill
from lxeskill.business import load_catalog
from services.agent_cli.mabang import generate_final_restock_recommendation as cli


def test_cli_forwards_the_three_offline_files(monkeypatch) -> None:
    expected = {
        "success": False,
        "store_name": "Amazon-Test",
        "source_data_time": "202610131000",
        "output_xlsx_path": "/tmp/final.xlsx",
        "row_count": 4,
        "formula_error_count": 1,
        "formula_error_examples": ["AC3=#VALUE!"],
        "exception": "Office 重算发现 1 个 Excel 错误单元格；实际错误示例: AC3=#VALUE!",
    }
    seen: dict[str, object] = {}

    def fake_generate(store_name: str, **kwargs):
        seen["store_name"] = store_name
        seen.update(kwargs)
        return SimpleNamespace(to_payload=lambda: expected)

    monkeypatch.setattr(cli, "generate_final_restock_recommendation", fake_generate)
    result = cli.run({
        "store_name": " Amazon-Test ",
        "msku_source_xlsx_path": "/inputs/source.xlsx",
        "shenzhen_inventory_report_xlsx_path": "/inputs/shenzhen.xlsx",
        "unlinked_shipments_snapshot_path": "/inputs/shipments.xlsx",
        "peak_boost_enabled": False, "peak_boost_days": None,
    })

    assert result == expected
    assert seen == {
        "store_name": "Amazon-Test",
        "msku_source_xlsx_path": "/inputs/source.xlsx",
        "shenzhen_inventory_report_xlsx_path": "/inputs/shenzhen.xlsx",
        "unlinked_shipments_snapshot_path": "/inputs/shipments.xlsx",
        "peak_boost_enabled": False, "peak_boost_days": None,
    }


def test_cli_preserves_actual_failure_diagnostic(monkeypatch) -> None:
    def fail(_store_name: str, **_kwargs):
        raise ValueError("深圳库存报告与本次 MSKU 源文件核验批次不一致")

    monkeypatch.setattr(cli, "generate_final_restock_recommendation", fail)
    assert cli.run({"store_name": "Amazon-Test"}) == {
        "success": False,
        "store_name": "Amazon-Test",
        "exception": "深圳库存报告与本次 MSKU 源文件核验批次不一致",
    }


@pytest.mark.parametrize("flags,enabled,days", [
    ([], False, None),
    (["--peak-boost-enabled", "--peak-boost-days", "20"], True, 20),
    (["--peak-boost-days", "0"], False, 0),
])
def test_internal_cli_transmits_request_settings_to_the_generator(
    tmp_path, monkeypatch, capsys, flags, enabled, days,
) -> None:
    from openpyxl import Workbook
    from services.mabang.amazon.fba.final_restock_workbook import FinalRestockWorkbookResult

    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    output = tmp_path / ".lxeagent/artifacts/replenish/final_restock_recommendation/result.xlsx"
    output.parent.mkdir(parents=True)
    book = Workbook()
    book.save(output)
    book.close()
    result = FinalRestockWorkbookResult("Amazon-Test", "202610201000", str(output), 1, 0, ())
    generate = Mock(return_value=result)
    monkeypatch.setattr(cli, "generate_final_restock_recommendation", generate)
    files = {
        "msku_source_xlsx_path": "source.xlsx",
        "shenzhen_inventory_report_xlsx_path": "inventory.xlsx",
        "unlinked_shipments_snapshot_path": "shipments.xlsx",
    }
    args = ["replenish", "final-restock", "generate", "--store-name", "Amazon-Test"]
    for key, value in files.items():
        args.extend(["--" + key.replace("_", "-"), value])
    assert lxeskill.main([*args, *flags]) == 0
    terminal = json.loads(capsys.readouterr().out)
    assert terminal["type"] == "result" and terminal["ok"] is True
    assert terminal["data"] == result.to_payload()
    assert terminal["files"] == [str(output)]
    generate.assert_called_once_with(
        "Amazon-Test", **files, peak_boost_enabled=enabled, peak_boost_days=days,
    )
    entry = load_catalog()["mabang_generate_final_restock_recommendation"]
    assert entry["visibility"] == "internal" and entry["exposed"] is False
    assert entry["owner_skills"] == []


@pytest.mark.parametrize("days", ["-1", "121"])
def test_cli_reports_invalid_days_before_reading_inputs(tmp_path, monkeypatch, capsys, days) -> None:
    from services.mabang.amazon.fba import final_restock_workbook as service

    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    read_input = Mock(side_effect=AssertionError("invalid days must not read input files"))
    monkeypatch.setattr(service, "_path", read_input)
    assert lxeskill.main([
        "replenish", "final-restock", "generate", "--store-name", "Amazon-Test",
        "--msku-source-xlsx-path", "source.xlsx", "--shenzhen-inventory-report-xlsx-path", "inventory.xlsx",
        "--unlinked-shipments-snapshot-path", "shipments.xlsx", "--peak-boost-days", days,
    ]) == lxeskill.EXIT_BUSINESS
    terminal = json.loads(capsys.readouterr().out)
    assert terminal["ok"] is False
    assert "peak_boost_days" in terminal["error"]["message"]
    read_input.assert_not_called()


def test_catalog_has_four_inputs_and_rejects_the_removed_flag(monkeypatch, capsys) -> None:
    entry = load_catalog()["mabang_generate_final_restock_recommendation"]
    required = ["store_name", "msku_source_xlsx_path", "shenzhen_inventory_report_xlsx_path",
                "unlinked_shipments_snapshot_path"]
    assert entry["input_schema"]["required"] == required
    assert list(entry["input_schema"]["properties"]) == [*required, "peak_boost_enabled", "peak_boost_days"]
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    assert lxeskill.main([
        "replenish", "final-restock", "generate", "--shenzhen-source-msku-xlsx-path", "source.xlsx",
    ]) == lxeskill.EXIT_USAGE
    terminal = json.loads(capsys.readouterr().out)
    assert terminal["error"]["code"] == "invalid_arguments"
    assert terminal["error"]["message"] == "unknown option: --shenzhen-source-msku-xlsx-path"
    assert terminal["files"] == []
