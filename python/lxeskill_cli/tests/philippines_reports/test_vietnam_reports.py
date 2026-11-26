"""Exercise the public Vietnam command using both real exporter workflows."""
from contextlib import closing
import json
from pathlib import Path

from openpyxl import load_workbook
import pytest
from lxeskill import cli

pytestmark = pytest.mark.usefixtures("ph_workspace")


def vietnam_files(ph_files):
    return ph_files(
        sales=[{"SKU": " 001 ", "仓库": "VN8806", "7天销量": 10, "15天销量": 4, "30天销量": 5, "可用": 100}],
        inventory=[{"SKU": "001", "仓库": "VN8806", "可用库存": 100}],
        tms=[{"库存SKU": "001", "仓库": "越南VN1仓", "可用库存": 30, "7天销量": 2, "15天销量": 3, "30天销量": 4}],
    )


def test_vietnam_command_delivers_two_files_with_original_and_merged_sheets(ph_files, ph_online, monkeypatch, capfd):
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "philippines-reports-export")
    paths = vietnam_files(ph_files)
    originals = {key: Path(path).read_bytes() for key, path in paths.items()}
    state = ph_online(paths, yacang_id=80, tms_id=12831)
    assert cli.main(["vietnam", "reports", "export"]) == 0
    record = json.loads(capfd.readouterr().out.splitlines()[-1])
    assert record["ok"] and len(record["files"]) == 2
    assert record["data"]["warehouses"] == {"yacang": "VN8806", "mabang-tms": "VN1"}
    sales, inventory = record["data"]["artifacts"]
    for item, names, prefix in ((sales, ["雅仓动销", "合并动销"], "越南库存动销-"),
                                 (inventory, ["雅仓库存", "合并库存"], "越南库存列表-")):
        assert Path(item["path"]).name.startswith(prefix)
        with closing(load_workbook(item["path"])) as book:
            assert book.sheetnames == names
            source_path = paths["sales_file" if item is sales else "inventory_file"]
            with closing(load_workbook(source_path)) as source:
                assert list(book.worksheets[0].values) == list(source.active.values)
            assert book.worksheets[0]["A1"].font.bold
            assert book.worksheets[1]["A1"].font.bold
            assert book.worksheets[1].column_dimensions["A"].width == 32
            headers = [cell.value for cell in book.worksheets[1][1]]
            row = dict(zip(headers, [cell.value for cell in book.worksheets[1][2]]))
            assert row["7天销量" if item is sales else "可用库存"] == (12 if item is sales else 130)
    assert {key: Path(path).read_bytes() for key, path in paths.items()} == originals
    assert any(call["source"] == "tms" for call in state["calls"])


@pytest.mark.parametrize('warehouse,yacang_id,tms_id', [('PH8805', 46, 12107), ('VN8806', 80, 12831)])
def test_yacang_standalone_export_still_available(ph_files, ph_online, monkeypatch, capfd, warehouse, yacang_id, tms_id):
    monkeypatch.setenv('LXESKILL_SKILL_SCOPE', 'yacang-reports-export')
    paths = ph_files() if warehouse == 'PH8805' else vietnam_files(ph_files)
    state = ph_online(paths, yacang_id=yacang_id, tms_id=tms_id)
    assert cli.main(['yacang', 'reports', 'export', '--report', 'inventory-sales', '--warehouse', warehouse]) == 0
    record = json.loads(capfd.readouterr().out.splitlines()[-1])
    assert record['ok'] and len(record['files']) == 1
    assert record['data']['artifacts'][0]['warehouse'] == warehouse
    assert all(call['source'] == 'yacang' for call in state['calls'])
    with closing(load_workbook(record['files'][0])) as book:
        assert len(book.worksheets) == 1
