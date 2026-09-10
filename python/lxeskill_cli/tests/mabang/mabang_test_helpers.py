from __future__ import annotations

from pathlib import Path


def _form_value(call: dict, name: str) -> str:
    for key, value in call.get("data", []):
        if key == name:
            return value
    raise AssertionError(f"missing form field: {name}")


def _form_values(call: dict, name: str) -> list[str]:
    return [value for key, value in call.get("data", []) if key == name]


def _sheet_names(path: Path) -> list[str]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True)
    try:
        return list(workbook.sheetnames)
    finally:
        workbook.close()


def _write_mabang_msku(
    path: Path,
    mskus: list[str],
    *,
    site: str = "美国站",
    include_site: bool = True,
) -> Path:
    from openpyxl import Workbook

    path.parent.mkdir(parents=True, exist_ok=True)
    workbook = Workbook()
    try:
        worksheet = workbook.active
        worksheet.title = "mskulist"
        headers = ["店铺名称", "MSKU"]
        if include_site:
            headers.insert(1, "站点")
        worksheet.append(headers)
        for msku in mskus:
            row = {"店铺名称": "Amazon-Test-US", "站点": site, "MSKU": msku}
            worksheet.append([row.get(header, "") for header in headers])
        workbook.save(path)
    finally:
        workbook.close()
    return path


def _xlsx_bytes(rows: list[dict], *, columns: list[str]) -> bytes:
    from io import BytesIO

    from openpyxl import Workbook

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.append(columns)
    for row in rows:
        worksheet.append([row.get(column, "") for column in columns])
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()


def _annotate_active_test_source(path: Path, *, requested_store_name: str | None = None) -> None:
    """Existing report fixtures represent verified product catalog records."""
    from openpyxl import load_workbook
    from services.mabang.amazon.fba.source_verification import annotate_source
    from services.mabang.amazon.fba.sku_catalog import SkuCatalogSnapshot, LocalSkuDefinition
    from services.mabang.amazon.fba.combo_sku import ComboComponent
    from decimal import Decimal
    workbook = load_workbook(path, read_only=True)
    try:
        values = workbook.worksheets[0].values
        headers = next(values)
        rows = [dict(zip(headers, row)) for row in values]
    finally:
        workbook.close()
    name = path.name.split('-', 1)[1].split('_', 1)[0]
    skus = tuple(LocalSkuDefinition(sku, 2, (ComboComponent('STOCK-A', Decimal(1)), ComboComponent('STOCK-B', Decimal(2))))
                 if sku.startswith('COMBO') else LocalSkuDefinition(sku, 1)
                 for sku in dict.fromkeys(str(row.get('本地SKU') or '') for row in rows) if sku)
    annotate_source(path, SkuCatalogSnapshot(name, '10', 'shopId', skus), requested_store_name=requested_store_name or name)



def _stamp_active_test_report(path: Path) -> None:
    from services.mabang.amazon.fba.source_verification import stamp_report
    name = path.name.split('-', 1)[1].split('_', 1)[0]
    stamp_report(path, {'version': 3, 'verification_method': 'stock_then_combo', 'scope': 'xlsx_all', 'unverified_rows': [], 'store_name': name, 'requested_store_name': name, 'source_fingerprint': 'a'*64, 'snapshot_id': 'b'*64, 'shop_id': '10', 'site': 'us', 'collected_at': '2026-09-07T00:00:00+00:00', 'original_row_count': 10, 'binding_verified_row_count': 10, 'binding_unverified_row_count': 0})
