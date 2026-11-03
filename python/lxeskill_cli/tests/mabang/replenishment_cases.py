"""Small business inputs shared by the PR's runtime tests; no production stubs."""
from decimal import Decimal
import json
from pathlib import Path
import subprocess
import sys

from openpyxl import Workbook, load_workbook

from services.mabang.amazon.fba import source_verification as provenance
from services.mabang.amazon.fba import store_msku_actual_inventory as inventory
from services.mabang.amazon.fba import unlinked_shipments as shipments
from services.mabang.amazon.fba.sku_catalog import LocalSkuDefinition, SkuCatalogSnapshot

STORE = "Amazon-Test"


def product(msku="SEA", **changes):
    row = {
        "MSKU": msku, "父ASIN": "PARENT", "ASIN": "ASIN-" + msku, "本地SKU": "S",
        "本地SKU名称": "=2+2", "商品名称": "测试商品", "备注": "",
        "商品链接": "https://example.test/" + msku,
        "7天销量": 42, "14天销量": 84, "30天销量": 180, "90天销量": 540,
        "可售": 450, "待入库": 10, "预留": 5, "计划入库": 999,
        "在途": 5, "待调仓": 5, "调仓中": 5, "单品重量(g)(cm)": "100g 10*10*10",
    }
    return {**row, **changes}


def write_table(path, rows, sheet="Sheet1"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    book = Workbook()
    ws = book.active
    ws.title = sheet
    headers = list(rows[0])
    ws.append(headers)
    for row in rows:
        ws.append([row.get(key) for key in headers])
        for cell in ws[ws.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    book.save(path)
    book.close()
    return path


def cells(path, *, formulas=False):
    book = load_workbook(path, data_only=not formulas)
    try:
        return {row[1].value: {cell.column_letter: cell.value for cell in row}
                for row in book.active.iter_rows(min_row=2)}
    finally:
        book.close()


def edit_cell(path, header, value, *, msku="SEA", sheet=None):
    book = load_workbook(path)
    try:
        ws = book[sheet] if sheet else book.active
        headers = [cell.value for cell in ws[1]]
        for row in ws.iter_rows(min_row=2):
            if row[headers.index("MSKU")].value == msku:
                row[headers.index(header)].value = value
                book.save(path)
                return
        raise AssertionError(f"fixture MSKU {msku} not found")
    finally:
        book.close()


def batch(root, *, rows=None, stocks=None, shipment_rows=None, snapshot_time="202610131100"):
    root = Path(root)
    rows = rows if rows is not None else [product()]
    source = write_table(root / "store_msku/202610131000-Amazon-Test_店铺MSKU数据.xlsx", rows)
    definitions = (
        LocalSkuDefinition("S", 1),
        LocalSkuDefinition("C", 2, (inventory.ComboComponent("A", Decimal(2)),
                                    inventory.ComboComponent("B", Decimal(3)))),
    )
    requested = {row["本地SKU"] for row in rows if row.get("本地SKU")}
    definitions = tuple(item for item in definitions if item.local_sku in requested)
    definitions += tuple(LocalSkuDefinition(sku, None) for sku in sorted(requested - {"S", "C"}))
    provenance.annotate_source(source, SkuCatalogSnapshot(STORE, "101", "shopId", definitions),
                               requested_store_name=STORE)
    verified = provenance.load_verified_source(source, store_name=STORE)
    report_rows, _ = inventory.calculate_inventory_rows(
        inventory.load_store_msku_rows(source, records=verified.records), combo_map=verified.combo_map,
        stock_quantities=stocks if stocks is not None else {"S": Decimal(12), "A": Decimal(20), "B": Decimal(21)},
        unverified_rows=provenance.unverified_reasons(verified.metadata),
    )
    report = inventory.write_actual_inventory_xlsx(
        report_rows, root / "actual_inventory/202610131000-Amazon-Test_真实库存（深圳仓库）.xlsx")
    provenance.stamp_report(report, verified.metadata)
    raw = [] if not shipment_rows else [write_table(root / "raw.xlsx", [
        {"店铺": STORE, "MSKU": msku, "MSKU发货量": quantity} for msku, quantity in shipment_rows])]
    query = shipments.StoreUnlinkedShipmentDownloadResult(STORE, 101, "202610131000", [
        shipments.UnlinkedShipmentStatusResult(spec.status_name, int(bool(raw) and index == 0),
                                              raw_file_path=str(raw[0]) if raw and index == 0 else "")
        for index, spec in enumerate(shipments.UNLINKED_SHIPMENT_STATUS_SPECS)
    ])
    snapshot = shipments.build_store_unlinked_shipments_snapshot(
        raw, store_name=STORE, output_dir=root / "shipments", snapshot_time=snapshot_time, query_result=query)
    return source, report, Path(snapshot.snapshot_xlsx_path)


def cli(*arguments, expected=0):
    child = subprocess.run([sys.executable, "-I", "-B", "-m", "lxeskill", *map(str, arguments)],
                           capture_output=True, text=True, encoding="utf-8", timeout=90)
    assert child.returncode == expected, child.stdout + child.stderr
    records = [json.loads(line) for line in child.stdout.splitlines() if line.strip()]
    terminals = [record for record in records if record.get("type") == "result"]
    assert len(terminals) == 1, records
    return terminals[0]


def generate(inputs, *options, expected=0):
    return cli("replenish", "v2", "generate", "--store-name", STORE,
               "--msku-source-xlsx-path", inputs[0], "--shenzhen-inventory-report-xlsx-path", inputs[1],
               "--unlinked-shipments-snapshot-path", inputs[2], *options, expected=expected)
