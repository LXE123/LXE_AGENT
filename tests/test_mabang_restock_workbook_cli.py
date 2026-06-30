from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.agent_cli.mabang import generate_restock_workbook as cli
from services.agent_cli.mabang import generate_fba_restock_workbook as restock_cli
from services.agent_cli.mabang import generate_purchase_summary_workbook as purchase_cli

PURCHASE_COLUMNS = (
    "库存sku",
    "产品名称",
    "来源SP单号",
    "库存sku（第一行）",
    "产品名称（第一行）",
    "型号",
    "原价",
    "厂家",
    "单位",
    "合同产品名称",
    "数量",
    "总价",
)
PURCHASE_UNMATCHED_COLUMNS = ("库存sku", "来源SP单号", "数量", "问题说明")
RESTOCK_COLUMNS = ("库存sku", "产品名称", "型号", "原价", "厂家", "单位", "合同产品名称", "数量", "总价")
RESTOCK_UNMATCHED_COLUMNS = ("库存sku", "数量", "问题说明")
MISSING_CONTRACT_SHEET_WARNING = "出口退税总表缺少 sheet: 供应商合同信息，单位和合同产品名称将留空"


def _first_line(value: object) -> object:
    if not isinstance(value, str):
        return value
    return value.split("\n", 1)[0]


def _purchase_row(
    stock_skus: object,
    product_names: object,
    source_delivery_nos: object,
    model: object,
    original_price: object,
    manufacturer: object,
    quantity: object,
    total_price: object,
    unit: object = None,
    contract_product_name: object = None,
) -> tuple[object, ...]:
    return (
        stock_skus,
        product_names,
        source_delivery_nos,
        _first_line(stock_skus),
        _first_line(product_names),
        model,
        original_price,
        manufacturer,
        unit,
        contract_product_name,
        quantity,
        total_price,
    )


def _write_delivery_csv(path: Path, rows: list[str]) -> None:
    headers = ["发货单号", "SKU发货量", "备注"]
    lines = [",".join(f'"{header}"' for header in headers)]
    for value in rows:
        lines.append(",".join(f'"{field}"' for field in ["SP260508022", value, ""]))
    path.write_text("\n".join(lines), encoding="utf-8-sig")


def _write_master_xlsx(
    path: Path,
    rows: list[dict[str, object]],
    *,
    columns: list[str] | None = None,
    contract_rows: list[dict[str, object]] | None = None,
    contract_columns: list[str] | None = None,
) -> None:
    from openpyxl import Workbook

    if columns is None:
        columns = ["库存sku", "产品名称", "型号", "原价", "厂家", "备用厂家"]

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "SKU表"
    worksheet.append(columns)
    for row in rows:
        worksheet.append([row.get(column, "") for column in columns])
    if contract_rows is not None:
        if contract_columns is None:
            contract_columns = ["供货方", "单位", "合同产品名称"]
        contract_sheet = workbook.create_sheet("供应商合同信息")
        contract_sheet.append(contract_columns)
        for row in contract_rows:
            contract_sheet.append([row.get(column, "") for column in contract_columns])
    workbook.save(path)


def _sheet_values(path: Path, sheet_name: str) -> list[tuple[object, ...]]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True)
    try:
        worksheet = workbook[sheet_name]
        return list(worksheet.iter_rows(values_only=True))
    finally:
        workbook.close()


def _sheet_names(path: Path) -> list[str]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True)
    try:
        return list(workbook.sheetnames)
    finally:
        workbook.close()


def _cell_wrap_text(path: Path, sheet_name: str, cell: str) -> bool | None:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True)
    try:
        return workbook[sheet_name][cell].alignment.wrap_text
    finally:
        workbook.close()


def _cell_number_format(path: Path, sheet_name: str, cell: str) -> str:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True)
    try:
        return str(workbook[sheet_name][cell].number_format)
    finally:
        workbook.close()


def _sheet_dimensions(path: Path, sheet_name: str) -> tuple[list[float | None], list[float | None]]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True)
    try:
        worksheet = workbook[sheet_name]
        widths = [
            worksheet.column_dimensions[worksheet.cell(row=1, column=column_index).column_letter].width
            for column_index in range(1, worksheet.max_column + 1)
        ]
        heights = [
            worksheet.row_dimensions[row_index].height
            for row_index in range(1, worksheet.max_row + 1)
        ]
        return widths, heights
    finally:
        workbook.close()


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


async def _noop_close_all_network_clients() -> None:
    return None


def test_generate_restock_workbook_groups_by_manufacturer(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    csv_path = csv_dir / "SP260508022_1.csv"
    _write_delivery_csv(csv_path, ["SKU-A × 2，SKU-B × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 1.5, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品B", "型号": "M-B", "原价": 2, "厂家": "厂家B"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    output_path = Path(payload["output_xlsx"])
    assert payload["success"] is True
    assert payload["delivery_nos"] == ["SP260508022"]
    assert payload["csv_paths"] == [str(csv_path)]
    assert payload["sku_count"] == 2
    assert payload["sku_source_count"] == 2
    assert payload["matched_sku_count"] == 2
    assert payload["unmatched_sku_count"] == 0
    assert payload["manufacturer_count"] == 2
    assert _sheet_names(output_path) == ["采购汇总", "未匹配", "厂家A", "厂家B"]
    assert _sheet_values(output_path, "采购汇总") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 1.5, "厂家A", 2, 3),
        _purchase_row("SKU-B", "产品B", "SP260508022", "M-B", 2, "厂家B", 3, 6),
    ]
    assert _sheet_values(output_path, "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 1.5, "厂家A", 2, 3),
    ]
    assert _sheet_values(output_path, "厂家B") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-B", "产品B", "SP260508022", "M-B", 2, "厂家B", 3, 6),
    ]
    assert _sheet_values(output_path, "未匹配") == [
        PURCHASE_UNMATCHED_COLUMNS,
    ]


def test_generate_restock_workbook_fills_contract_fields_from_second_sheet(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
        contract_rows=[
            {"供货方": "厂家A", "单位": "个", "合同产品名称": "合同产品A"},
            {"供货方": "厂家A", "单位": "个", "合同产品名称": "合同产品A"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    output_path = Path(payload["output_xlsx"])
    assert payload["warnings"] == []
    assert payload["contract_mapping_count"] == 1
    assert payload["contract_unmapped_manufacturer_count"] == 0
    assert payload["contract_conflict_manufacturer_count"] == 0
    assert _sheet_values(output_path, "采购汇总") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "厂家A", 2, 4, "个", "合同产品A"),
    ]
    assert _sheet_values(output_path, "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "厂家A", 2, 4, "个", "合同产品A"),
    ]


def test_generate_restock_workbook_warns_contract_mapping_conflict(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
        contract_rows=[
            {"供货方": "厂家A", "单位": "个", "合同产品名称": "合同产品A"},
            {"供货方": "厂家A", "单位": "套", "合同产品名称": "合同产品A"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["contract_mapping_count"] == 0
    assert payload["contract_conflict_manufacturer_count"] == 1
    assert payload["contract_conflict_manufacturer_examples"] == ["厂家A"]
    assert payload["warnings"] == [
        "出口退税总表 供应商合同信息 sheet 存在同一供货方对应不同单位或合同产品名称，"
        "相关厂家字段已留空: count=1, examples=厂家A"
    ]
    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "厂家A", 2, 4),
    ]


def test_generate_restock_workbook_warns_contract_mapping_missing_required_header(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
        contract_rows=[{"供货方": "厂家A", "单位": "个"}],
        contract_columns=["供货方", "单位"],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["contract_mapping_count"] == 0
    assert payload["warnings"] == [
        "出口退税总表 export_tax.xlsx 供应商合同信息 sheet 缺少必需列: 合同产品名称，单位和合同产品名称将留空"
    ]
    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "厂家A", 2, 4),
    ]


def test_generate_restock_workbook_warns_unmapped_contract_manufacturer(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
        contract_rows=[{"供货方": "厂家B", "单位": "个", "合同产品名称": "合同产品B"}],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["contract_mapping_count"] == 1
    assert payload["contract_unmapped_manufacturer_count"] == 1
    assert payload["contract_unmapped_manufacturer_examples"] == ["厂家A"]
    assert payload["warnings"] == [
        "出口退税总表 供应商合同信息 sheet 未找到部分厂家对应的供货方映射，"
        "单位和合同产品名称已留空: count=1, examples=厂家A"
    ]
    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "厂家A", 2, 4),
    ]


def test_generate_restock_workbook_sums_multiple_delivery_nos(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2"])
    _write_delivery_csv(csv_dir / "SP260508023_1.csv", ["SKU-A × 3，SKU-B × 1"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 4, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品B", "型号": "M-B", "原价": 2, "厂家": "厂家A"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022", "SP260508023"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["sku_source_count"] == 2
    assert Path(payload["output_xlsx"]).name == "SP260508022_SP260508023_purchase_summary.xlsx"
    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022\nSP260508023", "M-A", 4, "厂家A", 5, 20),
        _purchase_row("SKU-B", "产品B", "SP260508023", "M-B", 2, "厂家A", 1, 2),
    ]


def test_generate_restock_workbook_merges_rows_by_model_with_multiline_skus(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2，SKU-B × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    output_path = Path(payload["output_xlsx"])
    assert payload["matched_sku_count"] == 2
    assert payload["manufacturer_count"] == 1
    assert _sheet_values(output_path, "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A\nSKU-B", "产品A\n产品A", "SP260508022", "JZ-19", 2, "厂家A", 5, 10),
    ]
    assert _cell_wrap_text(output_path, "厂家A", "A2") is True
    assert _cell_wrap_text(output_path, "厂家A", "B2") is True
    assert _cell_wrap_text(output_path, "厂家A", "C2") is True
    widths, heights = _sheet_dimensions(output_path, "厂家A")
    assert widths == [15] * 12
    assert heights == [15] * 2
    widths, heights = _sheet_dimensions(output_path, "采购汇总")
    assert widths == [15] * 12
    assert heights == [15] * 2


def test_generate_restock_workbook_ignores_same_model_product_name_conflict(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2，SKU-B × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品B", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A\nSKU-B", "产品A\n产品B", "SP260508022", "JZ-19", 2, "厂家A", 5, 10),
    ]


def test_generate_restock_workbook_does_not_record_zero_quantity_source(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 0"])
    _write_delivery_csv(csv_dir / "SP260508023_1.csv", ["SKU-A × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022", "SP260508023"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["sku_source_count"] == 1
    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508023", "M-A", 2, "厂家A", 3, 6),
    ]


def test_generate_restock_workbook_rejects_same_model_with_different_price(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2，SKU-B × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品A", "型号": "JZ-19", "原价": 3, "厂家": "厂家A"},
        ],
    )

    with pytest.raises(RuntimeError, match="同一厂家同一型号的原价不一致"):
        cli.generate_restock_workbook(
            ["SP260508022"],
            master_xlsx=master_path,
            csv_dir=csv_dir,
            output_dir=tmp_path,
        )


def test_generate_restock_workbook_does_not_merge_same_model_across_manufacturers(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2，SKU-B × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家B"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    output_path = Path(payload["output_xlsx"])
    assert payload["manufacturer_count"] == 2
    assert _sheet_values(output_path, "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "JZ-19", 2, "厂家A", 2, 4),
    ]
    assert _sheet_values(output_path, "厂家B") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-B", "产品A", "SP260508022", "JZ-19", 2, "厂家B", 3, 6),
    ]


def test_generate_restock_workbook_keeps_empty_model_rows_unmerged_with_warning(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2，SKU-B × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品A", "型号": "", "原价": 2, "厂家": "厂家A"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["unmerged_empty_model_sku_count"] == 2
    assert payload["unmerged_empty_model_skus"] == ["SKU-A", "SKU-B"]
    assert payload["warnings"] == [
        MISSING_CONTRACT_SHEET_WARNING,
        "出口退税总表存在型号为空的库存sku，已按 SKU 粒度保留不合并: count=2, examples=SKU-A, SKU-B"
    ]
    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", None, 2, "厂家A", 2, 4),
        _purchase_row("SKU-B", "产品A", "SP260508022", None, 2, "厂家A", 3, 6),
    ]


def test_generate_restock_workbook_writes_unmatched_sheet(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 1，SKU-X × 4"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": ""}],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    output_path = Path(payload["output_xlsx"])
    assert payload["matched_sku_count"] == 1
    assert payload["unmatched_sku_count"] == 1
    assert payload["manufacturer_count"] == 1
    assert _sheet_names(output_path) == ["采购汇总", "未匹配", "未填写厂家"]
    assert _sheet_values(output_path, "采购汇总") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "未填写厂家", 1, 2),
    ]
    assert _sheet_values(output_path, "未填写厂家") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "未填写厂家", 1, 2),
    ]
    assert _sheet_values(output_path, "未匹配") == [
        PURCHASE_UNMATCHED_COLUMNS,
        ("SKU-X", "SP260508022", 4, "出口退税总表未找到库存sku"),
    ]
    widths, heights = _sheet_dimensions(output_path, "未匹配")
    assert widths == [15] * 4
    assert heights == [15] * 2


def test_generate_restock_workbook_unmatched_sources_use_line_breaks(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-X × 1"])
    _write_delivery_csv(csv_dir / "SP260508023_1.csv", ["SKU-X × 2"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022", "SP260508023"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert _sheet_values(Path(payload["output_xlsx"]), "未匹配") == [
        PURCHASE_UNMATCHED_COLUMNS,
        ("SKU-X", "SP260508022\nSP260508023", 3, "出口退税总表未找到库存sku"),
    ]


def test_generate_restock_workbook_purchase_summary_preserves_delivery_order(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-B × 3，SKU-A × 2"])
    _write_delivery_csv(csv_dir / "SP260508023_1.csv", ["SKU-C × 4，SKU-A × 1"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 1, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品B", "型号": "M-B", "原价": 1, "厂家": "厂家A"},
            {"库存sku": "SKU-C", "产品名称": "产品C", "型号": "M-C", "原价": 1, "厂家": "厂家A"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022", "SP260508023"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert _sheet_values(Path(payload["output_xlsx"]), "采购汇总") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-B", "产品B", "SP260508022", "M-B", 1, "厂家A", 3, 3),
        _purchase_row("SKU-A", "产品A", "SP260508022\nSP260508023", "M-A", 1, "厂家A", 3, 3),
        _purchase_row("SKU-C", "产品C", "SP260508023", "M-C", 1, "厂家A", 4, 4),
    ]


def test_generate_restock_workbook_total_price_number_format(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2，SKU-B × 1"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": "1.5", "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品B", "型号": "M-B", "原价": "0.125", "厂家": "厂家A"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    output_path = Path(payload["output_xlsx"])
    assert _cell_number_format(output_path, "采购汇总", "L2") == "0.00"
    assert _cell_number_format(output_path, "采购汇总", "L3") == "0.000"
    assert _cell_number_format(output_path, "厂家A", "L2") == "0.00"
    assert _cell_number_format(output_path, "厂家A", "L3") == "0.000"


def test_generate_restock_workbook_total_price_format_ignores_float_noise(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 195，SKU-B × 1"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {
                "库存sku": "SKU-A",
                "产品名称": "产品A",
                "型号": "M-A",
                "原价": "0.8500000000000001",
                "厂家": "厂家A",
            },
            {
                "库存sku": "SKU-B",
                "产品名称": "产品B",
                "型号": "M-B",
                "原价": "0.125",
                "厂家": "厂家A",
            },
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    output_path = Path(payload["output_xlsx"])
    assert _cell_number_format(output_path, "采购汇总", "L2") == "0.00"
    assert _cell_number_format(output_path, "采购汇总", "L3") == "0.000"


def test_generate_restock_workbook_dedupes_identical_master_stock_sku(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {
                "库存sku": "SKU-A",
                "产品名称": "产品A",
                "型号": "M-A",
                "原价": 2,
                "厂家": "厂家A",
                "备用厂家": "备用A",
            },
            {
                "库存sku": "SKU-A",
                "产品名称": "产品A",
                "型号": "M-A",
                "原价": 2.0,
                "厂家": "厂家A",
                "备用厂家": "备用A",
            },
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["success"] is True
    assert payload["matched_sku_count"] == 1
    assert payload["manufacturer_count"] == 1
    assert payload["deduped_duplicate_sku_count"] == 1
    assert payload["deduped_duplicate_row_count"] == 1
    assert payload["deduped_duplicate_sku_examples"] == ["SKU-A"]
    assert payload["warnings"] == [
        "出口退税总表存在完全相同的重复库存sku，已自动去重: "
        "sku_count=1, row_count=1, examples=SKU-A",
        MISSING_CONTRACT_SHEET_WARNING,
    ]
    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "厂家A", 2, 4),
    ]


def test_generate_restock_workbook_skips_master_rows_with_empty_stock_sku(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "", "产品名称": "无SKU产品", "型号": "M-X", "原价": "bad", "厂家": "厂家X"},
        ],
    )

    payload = cli.generate_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["success"] is True
    assert payload["matched_sku_count"] == 1
    assert payload["skipped_empty_sku_row_count"] == 1
    assert payload["skipped_empty_sku_rows"] == [3]
    assert payload["warnings"] == [
        "出口退税总表存在库存sku为空的行，已忽略: count=1, rows=3",
        MISSING_CONTRACT_SHEET_WARNING,
    ]
    assert _sheet_values(Path(payload["output_xlsx"]), "厂家A") == [
        PURCHASE_COLUMNS,
        _purchase_row("SKU-A", "产品A", "SP260508022", "M-A", 2, "厂家A", 2, 4),
    ]


def test_generate_restock_workbook_missing_local_delivery_csv_fails(tmp_path):
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
    )

    with pytest.raises(RuntimeError, match="本地未找到发货单 CSV"):
        cli.generate_restock_workbook(
            ["SP260508022"],
            master_xlsx=master_path,
            csv_dir=tmp_path / "missing",
            output_dir=tmp_path,
        )


def test_generate_restock_workbook_missing_master_fails(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 1"])

    with pytest.raises(RuntimeError, match="找不到出口退税总表"):
        cli.generate_restock_workbook(
            ["SP260508022"],
            master_xlsx=tmp_path / "missing.xlsx",
            csv_dir=csv_dir,
            output_dir=tmp_path,
        )


def test_load_master_products_requires_sku_sheet_name(tmp_path):
    from openpyxl import Workbook

    master_path = tmp_path / "export_tax.xlsx"
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "出口退税总表"
    worksheet.append(["库存sku", "产品名称", "型号", "原价", "厂家", "备用厂家"])
    worksheet.append(["SKU-A", "产品A", "M-A", 2, "厂家A", ""])
    workbook.save(master_path)

    with pytest.raises(RuntimeError, match="缺少 sheet: SKU表"):
        cli.load_master_products(master_path)


def test_load_master_products_missing_required_header_fails(tmp_path):
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
        columns=["库存sku", "产品名称", "型号", "原价", "厂家"],
    )

    with pytest.raises(RuntimeError, match="缺少必需列: 备用厂家"):
        cli.load_master_products(master_path)


def test_load_master_products_accepts_uppercase_sku_header_alias(tmp_path):
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存SKU": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
        columns=["库存SKU", "产品名称", "型号", "原价", "厂家", "备用厂家"],
    )

    products = cli.load_master_products(master_path)

    assert list(products) == ["SKU-A"]
    assert products["SKU-A"]["stock_sku"] == "SKU-A"


def test_load_master_products_rejects_duplicate_sku_header_aliases(tmp_path):
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {
                "库存sku": "SKU-A",
                "库存SKU": "SKU-A",
                "产品名称": "产品A",
                "型号": "M-A",
                "原价": 2,
                "厂家": "厂家A",
            }
        ],
        columns=["库存sku", "库存SKU", "产品名称", "型号", "原价", "厂家", "备用厂家"],
    )

    with pytest.raises(RuntimeError, match="第1行表头重复: 库存sku"):
        cli.load_master_products(master_path)


@pytest.mark.parametrize(
    ("changed_field", "changed_value"),
    [
        ("产品名称", "产品A2"),
        ("型号", "M-A2"),
        ("原价", 3),
        ("厂家", "厂家B"),
        ("备用厂家", "备用B"),
    ],
)
def test_load_master_products_duplicate_stock_sku_with_different_fields_fails(
    tmp_path,
    changed_field,
    changed_value,
):
    master_path = tmp_path / "export_tax.xlsx"
    duplicate_row = {
        "库存sku": "SKU-A",
        "产品名称": "产品A",
        "型号": "M-A",
        "原价": 2,
        "厂家": "厂家A",
        "备用厂家": "备用A",
    }
    duplicate_row[changed_field] = changed_value
    _write_master_xlsx(
        master_path,
        [
            {
                "库存sku": "SKU-A",
                "产品名称": "产品A",
                "型号": "M-A",
                "原价": 2,
                "厂家": "厂家A",
                "备用厂家": "备用A",
            },
            duplicate_row,
        ],
    )

    with pytest.raises(RuntimeError, match="库存sku重复且字段不一致: SKU-A, 首次行=2, 冲突行=3"):
        cli.load_master_products(master_path)


def test_load_master_products_invalid_price_fails(tmp_path):
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": "abc", "厂家": "厂家A"}],
    )

    with pytest.raises(RuntimeError, match="原价非数字: abc"):
        cli.load_master_products(master_path)


def test_load_master_products_reads_large_master_with_streaming_rows(tmp_path):
    from openpyxl import Workbook

    master_path = tmp_path / "large_export_tax.xlsx"
    workbook = Workbook(write_only=True)
    worksheet = workbook.create_sheet("SKU表")
    worksheet.append(["库存sku", "产品名称", "型号", "原价", "厂家", "备用厂家"])
    for index in range(1, 15001):
        worksheet.append([f"SKU-{index}", f"产品{index}", f"M-{index}", 1.23, f"厂家{index % 7}", ""])
    workbook.save(master_path)

    products = cli.load_master_products(master_path)

    assert len(products) == 15000
    assert products["SKU-1"]["stock_sku"] == "SKU-1"
    assert products["SKU-15000"]["manufacturer"] == "厂家6"


def test_main_outputs_success_json(monkeypatch, tmp_path, capsys):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 1"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
    )
    monkeypatch.setattr(cli, "DELIVERY_CSV_DIR", csv_dir)
    monkeypatch.setattr(cli, "OUTPUT_DIR", tmp_path / "out")
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = cli.main(["--delivery-no", "SP260508022", "--master-xlsx", str(master_path)])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["success"] is True
    assert payload["source"] == "fba_purchase_summary"
    assert Path(payload["output_xlsx"]).is_file()


def test_purchase_summary_main_outputs_success_json(monkeypatch, tmp_path, capsys):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 1"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
    )
    monkeypatch.setattr(purchase_cli, "DELIVERY_CSV_DIR", csv_dir)
    monkeypatch.setattr(purchase_cli, "OUTPUT_DIR", tmp_path / "out")
    monkeypatch.setattr(purchase_cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = purchase_cli.main(["--delivery-no", "SP260508022", "--master-xlsx", str(master_path)])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["success"] is True
    assert payload["source"] == "fba_purchase_summary"
    assert Path(payload["output_xlsx"]).name == "SP260508022_purchase_summary.xlsx"
    assert Path(payload["output_xlsx"]).is_file()


def test_generate_fba_restock_workbook_writes_single_sp_restock_sheet(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    csv_path = csv_dir / "SP260508022_1.csv"
    _write_delivery_csv(csv_path, ["SKU-B × 3，SKU-A × 2，SKU-X × 4"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品B", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
        ],
        contract_rows=[{"供货方": "厂家A", "单位": "个", "合同产品名称": "合同产品A"}],
    )

    payload = restock_cli.generate_fba_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    output_path = Path(payload["output_xlsx"])
    assert payload["success"] is True
    assert payload["source"] == "fba_restock_workbook"
    assert payload["delivery_no"] == "SP260508022"
    assert payload["csv_path"] == str(csv_path)
    assert payload["matched_sku_count"] == 2
    assert payload["unmatched_sku_count"] == 1
    assert payload["contract_mapping_count"] == 1
    assert Path(payload["output_xlsx"]).name == "SP260508022_restock_workbook.xlsx"
    assert _sheet_names(output_path) == ["备货单", "未匹配"]
    assert _sheet_values(output_path, "备货单") == [
        RESTOCK_COLUMNS,
        ("SKU-B\nSKU-A", "产品B\n产品A", "JZ-19", 2, "厂家A", "个", "合同产品A", 5, 10),
    ]
    assert _sheet_values(output_path, "未匹配") == [
        RESTOCK_UNMATCHED_COLUMNS,
        ("SKU-X", 4, "出口退税总表未找到库存sku"),
    ]
    widths, heights = _sheet_dimensions(output_path, "备货单")
    assert widths == [15] * 9
    assert heights == [15] * 2
    assert _cell_wrap_text(output_path, "备货单", "A2") is True
    assert _cell_number_format(output_path, "备货单", "I2") == "0.00"


def test_generate_fba_restock_workbook_rejects_multiple_delivery_nos(tmp_path):
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
    )

    with pytest.raises(ValueError, match="一次只能处理一个 --delivery-no"):
        restock_cli.generate_fba_restock_workbook(
            ["SP260508022", "SP260508023"],
            master_xlsx=master_path,
            csv_dir=tmp_path,
            output_dir=tmp_path,
        )


def test_generate_fba_restock_workbook_missing_local_delivery_csv_fails(tmp_path):
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
    )

    with pytest.raises(RuntimeError, match="本地未找到发货单 CSV"):
        restock_cli.generate_fba_restock_workbook(
            ["SP260508022"],
            master_xlsx=master_path,
            csv_dir=tmp_path / "missing",
            output_dir=tmp_path,
        )


def test_generate_fba_restock_workbook_missing_master_fails(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 1"])

    with pytest.raises(RuntimeError, match="找不到出口退税总表"):
        restock_cli.generate_fba_restock_workbook(
            ["SP260508022"],
            master_xlsx=tmp_path / "missing.xlsx",
            csv_dir=csv_dir,
            output_dir=tmp_path,
        )


def test_generate_fba_restock_workbook_warns_same_model_across_manufacturers(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2，SKU-B × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品B", "型号": "JZ-19", "原价": 2, "厂家": "厂家B"},
        ],
    )

    payload = restock_cli.generate_fba_restock_workbook(
        ["SP260508022"],
        master_xlsx=master_path,
        csv_dir=csv_dir,
        output_dir=tmp_path,
    )

    assert payload["cross_manufacturer_model_count"] == 1
    assert payload["warnings"] == [
        MISSING_CONTRACT_SHEET_WARNING,
        "不同厂家有相同型号，已保留为不同行，请业务人员核查: count=1, examples=JZ-19: 厂家A, 厂家B"
    ]
    assert _sheet_values(Path(payload["output_xlsx"]), "备货单") == [
        RESTOCK_COLUMNS,
        ("SKU-A", "产品A", "JZ-19", 2, "厂家A", None, None, 2, 4),
        ("SKU-B", "产品B", "JZ-19", 2, "厂家B", None, None, 3, 6),
    ]


def test_generate_fba_restock_workbook_rejects_same_manufacturer_model_with_different_price(tmp_path):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 2，SKU-B × 3"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [
            {"库存sku": "SKU-A", "产品名称": "产品A", "型号": "JZ-19", "原价": 2, "厂家": "厂家A"},
            {"库存sku": "SKU-B", "产品名称": "产品B", "型号": "JZ-19", "原价": 3, "厂家": "厂家A"},
        ],
    )

    with pytest.raises(RuntimeError, match="同一厂家同一型号的原价不一致"):
        restock_cli.generate_fba_restock_workbook(
            ["SP260508022"],
            master_xlsx=master_path,
            csv_dir=csv_dir,
            output_dir=tmp_path,
        )


def test_fba_restock_main_outputs_success_json(monkeypatch, tmp_path, capsys):
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(csv_dir / "SP260508022_1.csv", ["SKU-A × 1"])
    master_path = tmp_path / "export_tax.xlsx"
    _write_master_xlsx(
        master_path,
        [{"库存sku": "SKU-A", "产品名称": "产品A", "型号": "M-A", "原价": 2, "厂家": "厂家A"}],
    )
    monkeypatch.setattr(restock_cli, "DELIVERY_CSV_DIR", csv_dir)
    monkeypatch.setattr(restock_cli, "OUTPUT_DIR", tmp_path / "out")
    monkeypatch.setattr(restock_cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = restock_cli.main(["--delivery-no", "SP260508022", "--master-xlsx", str(master_path)])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["success"] is True
    assert payload["source"] == "fba_restock_workbook"
    assert Path(payload["output_xlsx"]).name == "SP260508022_restock_workbook.xlsx"
    assert Path(payload["output_xlsx"]).is_file()
