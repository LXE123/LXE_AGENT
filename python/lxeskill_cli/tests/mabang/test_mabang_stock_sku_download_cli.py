from __future__ import annotations

import os
from types import SimpleNamespace

from services.agent_cli.mabang import download_stock_sku_excel as cli


def _write_delivery_csv(path, rows: list[dict[str, str]], *, columns: list[str] | None = None) -> None:
    import csv

    if columns is None:
        columns = ["SKU", "SKU发货量", "MSKU"]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def test_missing_delivery_no_returns_failure_json(monkeypatch, capsys):

    payload = cli.run({})

    assert payload == {
        "success": False,
        "delivery_no": "",
        "exception": "delivery_no 不能为空",
    }


def test_invalid_delivery_no_returns_failure_json(monkeypatch, capsys):

    payload = cli.run({"delivery_no": "FBA123"})

    assert payload == {
        "success": False,
        "delivery_no": "FBA123",
        "exception": "delivery_no 格式无效: FBA123",
    }


def test_find_latest_delivery_csv_picks_newest_file(tmp_path):
    older = tmp_path / "SP260508022_1.csv"
    newer = tmp_path / "SP260508022_2.csv"
    _write_delivery_csv(older, [{"SKU发货量": "SKU-A × 1"}])
    _write_delivery_csv(newer, [{"SKU发货量": "SKU-B × 1"}])
    os.utime(older, (1000, 1000))
    os.utime(newer, (2000, 2000))

    assert cli.find_latest_delivery_csv("sp260508022", csv_dir=tmp_path) == newer


def test_missing_local_delivery_csv_does_not_export(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(cli, "DELIVERY_CSV_DIR", tmp_path)

    async def fail_export(*args, **kwargs):
        raise AssertionError("不应在缺少本地发货单时导出库存 SKU")

    monkeypatch.setattr(cli, "export_stock_sku_names", fail_export)

    payload = cli.run({"delivery_no": "SP260508022"})

    assert payload["success"] is False
    assert payload["delivery_no"] == "SP260508022"
    assert "本地未找到发货单 CSV" in payload["exception"]


def test_extract_stock_skus_requires_sku_ship_quantity_column(tmp_path):
    csv_path = tmp_path / "SP260508022_1.csv"
    _write_delivery_csv(csv_path, [{"MSKU": "MSKU-A"}], columns=["MSKU"])

    try:
        cli.extract_stock_skus_from_delivery_csv(csv_path)
    except RuntimeError as exc:
        assert "发货单 CSV 缺少列: SKU发货量" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_extract_stock_skus_dedupes_and_preserves_order(tmp_path):
    csv_path = tmp_path / "SP260508022_1.csv"
    _write_delivery_csv(
        csv_path,
        [
            {"SKU发货量": "SKU-A × 1，SKU-B x 2"},
            {"SKU发货量": "SKU-A X 3, SKU-C * 4"},
            {"SKU发货量": ""},
        ],
    )

    assert cli.extract_stock_skus_from_delivery_csv(csv_path) == ["SKU-A", "SKU-B", "SKU-C"]


def test_extract_stock_skus_keeps_zero_quantity_items(tmp_path):
    csv_path = tmp_path / "SP260511002_1.csv"
    _write_delivery_csv(
        csv_path,
        [
            {"SKU发货量": "DX250801602 × 15"},
            {"SKU发货量": "DX250801603 × 0，DX250801614 × 0"},
        ],
    )

    assert cli.extract_stock_skus_from_delivery_csv(csv_path) == [
        "DX250801602",
        "DX250801603",
        "DX250801614",
    ]


def test_extract_stock_skus_uses_sku_ship_quantity_not_sku_column(tmp_path):
    csv_path = tmp_path / "SP260424001_1.csv"
    _write_delivery_csv(
        csv_path,
        [
            {
                "SKU": "AMDDP2506142S03",
                "SKU发货量": "DP2506142S03 × 2200，DP20630730 × 2200",
            }
        ],
    )

    assert cli.extract_stock_skus_from_delivery_csv(csv_path) == ["DP2506142S03", "DP20630730"]


def test_extract_stock_skus_rejects_unparseable_item(tmp_path):
    csv_path = tmp_path / "SP260508022_1.csv"
    _write_delivery_csv(csv_path, [{"SKU发货量": "SKU-A"}])

    try:
        cli.extract_stock_skus_from_delivery_csv(csv_path)
    except RuntimeError as exc:
        assert "第2行 SKU发货量 格式无法解析: SKU-A" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_success_exports_stock_sku_excel(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(cli, "DELIVERY_CSV_DIR", tmp_path)
    stock_output_dir = tmp_path / "stock"
    monkeypatch.setattr(cli, "STOCK_SKU_OUTPUT_DIR", stock_output_dir)
    csv_path = tmp_path / "SP260508022_1.csv"
    _write_delivery_csv(
        csv_path,
        [
            {"SKU": "COMBO-A", "SKU发货量": "SKU-A × 1，SKU-B × 2"},
            {"SKU": "COMBO-B", "SKU发货量": "SKU-A × 3"},
        ],
    )

    async def fake_export_stock_sku_names(skus, *, delivery_no="", output_dir=None, **kwargs):
        assert skus == ["SKU-A", "SKU-B"]
        assert delivery_no == "SP260508022"
        assert output_dir == stock_output_dir
        return SimpleNamespace(xlsx_paths=[str(stock_output_dir / "SP260508022_batch001.xlsx")])

    monkeypatch.setattr(cli, "export_stock_sku_names", fake_export_stock_sku_names)

    payload = cli.run({"delivery_no": "sp260508022"})

    assert payload == {
        "success": True,
        "delivery_no": "SP260508022",
        "delivery_csv_path": str(csv_path),
        "sku_count": 2,
        "source_column": "SKU发货量",
        "batch_count": 1,
        "xlsx_paths": [str(stock_output_dir / "SP260508022_batch001.xlsx")],
        "source": "mabang_stock_sku_download",
    }
