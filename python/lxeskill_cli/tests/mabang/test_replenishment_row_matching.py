from test_mabang_store_msku_replenishment import _read_sales_details
from dataclasses import replace

import pytest
from openpyxl import load_workbook

from services.mabang.amazon.fba import store_msku_replenishment as repl
from test_mabang_store_msku_replenishment import _write_inventory_report, _write_sales_report


def set_parent(path, sheet_name, value):
    book = load_workbook(path)
    sheet = book[sheet_name]
    column = [cell.value for cell in sheet[1]].index("父ASIN") + 1
    sheet.cell(2, column).value = value
    book.save(path)
    book.close()


@pytest.mark.parametrize("parent", [None, "", " \t ", "未填写父ASIN", "PARENT-SEA"])
def test_existing_reports_calculate_with_all_parent_representations(tmp_path, parent):
    sales = _write_sales_report(tmp_path / "sales/202605251530-Amazon-Test_销量分析.xlsx")
    inventory = _write_inventory_report(tmp_path / "inventory/202605251530-Amazon-Test_真实库存（深圳仓库）.xlsx")
    set_parent(sales, "MSKU明细", parent)
    set_parent(inventory, "真实库存（深圳仓库）-组合sku", parent)
    original = {path: path.read_bytes() for path in (sales, inventory)}

    rows = repl.calculate_replenishment_rows(repl.load_inventory_rows(inventory), _read_sales_details(sales))
    output = repl.write_replenishment_report(rows, tmp_path / "output.xlsx")
    assert len(rows) == 5
    assert output.is_file()
    assert all(path.read_bytes() == data for path, data in original.items())
    assert rows[0].parent_asin == (parent.strip() if parent and parent.strip() else "未填写父ASIN")


def test_inventory_msku_requires_matching_source(tmp_path):
    sales = _write_sales_report(tmp_path / "sales/202605251530-Amazon-Test_销量分析.xlsx")
    inventory = _write_inventory_report(tmp_path / "inventory/202605251530-Amazon-Test_真实库存（深圳仓库）.xlsx")
    set_parent(sales, "MSKU明细", None)
    set_parent(inventory, "真实库存（深圳仓库）-组合sku", None)
    row = replace(repl.load_inventory_rows(inventory)[0], msku="different")
    with pytest.raises(repl.StoreMskuReplenishmentError, match="MSKU源数据缺少匹配行"):
        repl.calculate_replenishment_rows([row], _read_sales_details(sales))
