from contextlib import closing
from functools import partial
import io
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
import pytest
import requests

from services.mabang_tms import workflow as tms_workflow
from services.mabang_tms.client import TmsClient
from services.yacang.auth_state import YacangAuthState
from services.yacang.contracts import Credentials
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
    def unexpected_network(*args, **kwargs):
        pytest.fail("unexpected HTTP request outside the offline export fixture")

    monkeypatch.setattr(requests.Session, "send", unexpected_network)
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "philippines-reports-export")
    try:
        with monkeypatch.context() as environment:
            for name, value in {
                "LXE_WORKSPACE_ROOT": str(tmp_path / "workspace"),
                "LXE_DATA_ROOT": str(tmp_path / "state"),
                "LXE_SQLITE_DB_PATH": str(tmp_path / "state/db/lxeskill.sqlite3"),
                "LXE_YACANG_MOBILE": "yacang-test-account",
                "LXE_YACANG_PASSWORD": "yacang-test-password",
                "LXE_MABANG_TMS_ACCOUNT": "tms-test-account",
                "LXE_MABANG_TMS_PASSWORD": "tms-test-password",
            }.items():
                environment.setenv(name, value)
            activate_project_workspace()
            yield
    finally:
        activate_project_workspace()


@pytest.fixture
def ph_online(ph_workspace, monkeypatch):
    """Synthetic HTTP responses; both ERP clients, workflows and storage are real."""
    def install(paths):
        state = {"calls": [], "queue": [], "reject": {}, "downloaded": set(), "tms_records": []}
        with closing(load_workbook(paths["tms_file"])) as book:
            rows = book.active.iter_rows(values_only=True)
            headers = next(rows)
            for index, row in enumerate(rows, 1):
                values = dict(zip(headers, row))
                state["tms_records"].append({
                    "id": index, "stockSku": values["库存SKU"], "warehouseId": 12107,
                    "warehouseName": values["仓库"], "stockQuantity": values["可用库存"],
                    "sale1": values["7天销量"], "sale2": values["15天销量"], "sale3": values["30天销量"],
                })

        def response(request, status, body):
            result = requests.Response()
            result.status_code, result.url, result.request = status, request.url, request
            result._content = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
            result._content_consumed = True
            result.headers["Content-Length"] = str(len(result._content))
            return result

        def send(_session, request, **kwargs):
            url = urlsplit(request.url)
            params = {key: values[0] for key, values in parse_qs(url.query).items()}
            body = json.loads(request.body or "{}")
            source = "yacang" if url.hostname in {"api-oms.seaya.cn", "oss-accelerate.seaya.cn"} else "tms"
            operation = url.path.rsplit("/", 1)[-1]
            if url.hostname == "api-oms.seaya.cn":
                operation = {"/sys/customer/mrpPrepare/export": "sales-submit",
                             "/sys/customer/stockWarehouse/export": "inventory-submit",
                             "/sys/customer/downPath/list": "queue"}[url.path]
                if (operation == "queue" and "sales" in state["downloaded"]
                        and not any(row["type"] == "1" for row in state["queue"])):
                    operation = "inventory-baseline"
            state["calls"].append({"source": source, "operation": operation, "params": params, "body": body})
            rejected = state["reject"].get((source, operation))
            if isinstance(rejected, Exception):
                raise rejected
            if rejected:
                return response(request, *rejected)
            if source == "yacang":
                if url.hostname == "oss-accelerate.seaya.cn":
                    report = "sales" if operation == "sales.xlsx" else "inventory"
                    state["downloaded"].add(report)
                    if report == "sales":
                        with closing(load_workbook(paths["sales_file"])) as book:
                            sheet = book.active
                            if sheet.max_column == 15:
                                sheet.cell(1, 16, "创建日期")
                                for row in range(2, sheet.max_row + 1):
                                    sheet.cell(row, 16, "2026-11-05 00:00:00")
                            content = io.BytesIO()
                            book.save(content)
                        return response(request, 200, content.getvalue())
                    return response(request, 200, Path(paths["inventory_file"]).read_bytes())
                if operation in {"queue", "inventory-baseline"}:
                    return response(request, 200, {"status": 1, "data": {"list": state["queue"]}})
                assert params["warehouse_id"] == "46"
                inventory = operation == "inventory-submit"
                report = "inventory" if inventory else "sales"
                state["queue"].append({
                    "id": str(len(state["queue"]) + 1), "type": "1" if inventory else "10",
                    "name": "库存导出" if inventory else "库存动销导出",
                    "param_where": {"warehouse_id": "46", **({"goods_sku_condition": "2"} if inventory else {})},
                    "path": f"https://oss-accelerate.seaya.cn/{report}.xlsx",
                })
                return response(request, 200, {"status": 1})
            if operation == "login":
                return response(request, 200, {"code": "200", "data": {"apiToken": "tms-offline-token"}})
            if operation == "findMyStockwarehouseList":
                assert body["warehouseId"] == 12107
                return response(request, 200, {"code": "200", "datas": state["tms_records"],
                                               "totalNum": len(state["tms_records"]), "page": body["page"]})
            if operation == "exportStockwarehouse":
                assert body["warehouseId"] == 12107
                return response(request, 200, {"code": "200", "pop": "https://tms-cos.mabangerp.com/offline.xlsx"})
            assert url.hostname == "tms-cos.mabangerp.com" and operation == "offline.xlsx"
            return response(request, 200, Path(paths["tms_file"]).read_bytes())

        monkeypatch.setattr(requests.Session, "send", send)
        monkeypatch.setattr("services.yacang.state.time.sleep", lambda _: None)
        monkeypatch.setattr(tms_workflow, "TmsClient", partial(TmsClient, sleeper=lambda _: None))
        YacangAuthState(Credentials.from_environment()).save_session("yacang-offline-token")
        return state
    return install
