from contextlib import closing
from unittest.mock import Mock

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
import pytest

from services.philippines_reports import workflow
from services.yacang.validation import INVENTORY_LIST_HEADERS, INVENTORY_SALES_DELIVERY_HEADERS
from shared.workspace import activate_project_workspace


TMS_HEADERS = ("库存SKU", "30天销量", "7天销量", "可用库存", "15天销量", "仓库",
               "库存量", "在途量", "成本价", "采购价", "入库时间", "90天销量")


@pytest.fixture
def ph_files(tmp_path):
    def create(*, sales=None, inventory=None, tms=None,
               sales_headers=INVENTORY_SALES_DELIVERY_HEADERS, tms_headers=TMS_HEADERS):
        sources = {
            "sales_file": (sales_headers, sales if sales is not None else [
                {"SKU": "001", "仓库": "PH8805", "7天销量": 10, "可用": 100}]),
            "inventory_file": (INVENTORY_LIST_HEADERS, inventory if inventory is not None else [
                {"SKU": "001", "仓库": "PH8805", "可用库存": 100}]),
            "tms_file": (tms_headers, tms if tms is not None else [
                {"库存SKU": "001", "仓库": "菲律宾PH1仓", "可用库存": 30, "7天销量": 2}]),
        }
        paths = {}
        for key, (headers, rows) in sources.items():
            book = Workbook()
            sheet = book.active
            sheet.title = {"sales_file": "Sheet1", "inventory_file": "Sheet", "tms_file": "商品"}[key]
            sheet.append(headers)
            for values in rows:
                sheet.append([values.get(header) for header in headers])
                for cell in sheet[sheet.max_row]:
                    if isinstance(cell.value, str):
                        cell.data_type = "s"
            sheet["A1"].font = Font(bold=True, color="112233")
            sheet["A1"].fill = PatternFill("solid", fgColor="ABCDEF")
            sheet.column_dimensions["A"].width = 32
            sheet.row_dimensions[1].height = 28
            sheet.freeze_panes = "B2"
            sheet.auto_filter.ref = sheet.dimensions
            sheet.sheet_view.showGridLines = False
            paths[key] = str(tmp_path / f"{key}.xlsx")
            book.save(paths[key])
            book.close()
        return paths
    return create


@pytest.fixture
def ph_rows():
    def read(artifact):
        with closing(load_workbook(artifact["path"])) as book:
            rows = book.worksheets[1].iter_rows(values_only=True)
            headers = next(rows)
            return [dict(zip(headers, row)) for row in rows]
    return read


@pytest.fixture
def ph_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path / "workspace"))
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "philippines-reports-export")
    activate_project_workspace()
    monkeypatch.setattr(workflow.yacang_workflow, "run", lambda *args: pytest.fail("unexpected Yacang export"))
    monkeypatch.setattr(workflow.tms_workflow, "run_with_events", lambda *args: pytest.fail("unexpected TMS export"))


@pytest.fixture
def ph_online(monkeypatch):
    def install(paths):
        yacang = {"success": True, "status": "completed", "artifacts": [
            {"source": "yacang", "report": report, "warehouse": "PH8805", "created_date": None,
             "path": paths[key], "row_count": 1}
            for key, report in (("sales_file", "inventory-sales"), ("inventory_file", "inventory-current-snapshot"))
        ]}
        tms = {"success": True, "status": "completed", "warehouse": "PH1", "warehouse_id": 12107,
               "warehouse_scope": "selected_warehouse", "reported_total": 1, "read_unique_ids": 1,
               "exported_unique_ids": 1, "remaining_records": 0, "source_row_count": 1,
               "row_count": 1, "distinct_skus": 1, "artifacts": [{
                   "path": paths["tms_file"], "warehouse": "菲律宾PH1仓", "row_count": 1}]}
        yacang_mock, tms_mock = Mock(return_value=yacang), Mock(return_value=tms)
        monkeypatch.setattr(workflow.yacang_workflow, "run", yacang_mock)
        monkeypatch.setattr(workflow.tms_workflow, "run_with_events", tms_mock)
        return yacang, tms, yacang_mock, tms_mock
    return install
