from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.agent_cli.mabang import validate_export_tax_products as cli


def _write_products(
    path: Path,
    rows: list[dict[str, str]],
    *,
    columns: list[str] | None = None,
    sheet_name: str = "Sheet1",
) -> None:
    import pandas as pd

    if columns is None:
        columns = ["sku", "产品名称"]
    frame_rows = [{column: row.get(column, "") for column in columns} for row in rows]
    pd.DataFrame(frame_rows, columns=columns).to_excel(path, sheet_name=sheet_name, index=False)


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def test_main_missing_file_returns_failure_json(capsys):
    exit_code = cli.main(["--path", "missing.xlsx"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload["success"] is False
    assert payload["products_path"] == "missing.xlsx"
    assert "找不到出口退税产品表" in payload["exception"]


def test_main_missing_sheet_returns_failure_json(tmp_path, capsys):
    products_path = tmp_path / "products.xlsx"
    _write_products(products_path, [{"sku": "SKU-A", "产品名称": "产品A"}], sheet_name="Other")

    exit_code = cli.main(["--path", str(products_path)])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload["success"] is False
    assert "缺少 sheet: Sheet1" in payload["exception"]


def test_main_missing_columns_returns_failure_json(tmp_path, capsys):
    products_path = tmp_path / "products.xlsx"
    _write_products(products_path, [{"sku": "SKU-A"}], columns=["sku"])

    exit_code = cli.main(["--path", str(products_path)])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload["success"] is False
    assert "缺少列: 产品名称" in payload["exception"]


def test_main_empty_sku_returns_failure_json(tmp_path, capsys):
    products_path = tmp_path / "products.xlsx"
    _write_products(products_path, [{"sku": "", "产品名称": "产品A"}])

    exit_code = cli.main(["--path", str(products_path)])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload["success"] is False
    assert "存在空 sku" in payload["exception"]


def test_duplicate_sku_returns_success_with_warning_stats(tmp_path):
    products_path = tmp_path / "products.xlsx"
    _write_products(
        products_path,
        [
            {"sku": " SKU-A ", "产品名称": "产品A"},
            {"sku": "SKU-B", "产品名称": "产品B"},
            {"sku": "SKU-A", "产品名称": "重复产品A"},
            {"sku": "S K U-B", "产品名称": "重复产品B"},
        ],
    )

    payload = cli.validate_export_tax_products(products_path)

    assert payload["success"] is True
    assert payload["row_count"] == 4
    assert payload["valid_sku_count"] == 4
    assert payload["unique_sku_count"] == 2
    assert payload["empty_sku_count"] == 0
    assert payload["duplicate_sku_count"] == 2
    assert payload["duplicate_row_count"] == 2
    assert payload["duplicate_sku_examples"] == ["SKU-A", "SKU-B"]
    assert payload["duplicate_policy"] == "keep_first"


def test_main_success_outputs_json(tmp_path, capsys):
    products_path = tmp_path / "products.xlsx"
    _write_products(
        products_path,
        [
            {"sku": "SKU-A", "产品名称": "产品A"},
            {"sku": "SKU-B", "产品名称": "产品B"},
        ],
    )

    exit_code = cli.main(["--path", str(products_path)])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["success"] is True
    assert payload["products_path"] == str(products_path)
    assert payload["sheet_name"] == "Sheet1"
    assert payload["row_count"] == 2
    assert payload["valid_sku_count"] == 2
    assert payload["duplicate_sku_count"] == 0
    assert payload["source"] == "export_tax_products_validation"


def test_default_path_is_xlsx():
    assert cli.EXPORT_TAX_PRODUCTS_PATH.name == "export_tax_products.xlsx"
