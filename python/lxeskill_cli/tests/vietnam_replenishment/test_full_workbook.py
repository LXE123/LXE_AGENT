"""The exported nine-sheet workbook retains the user's four business tabs."""

from __future__ import annotations

from hashlib import sha256
from importlib.resources import files
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from openpyxl import load_workbook
from openpyxl.styles import Font
import pytest

from services.vietnam_replenishment.asset_contract import AssetContractError, load_template_sku_parameters
from services.vietnam_replenishment.full_workbook import (
    REQUIRED_ORDER, UNCHANGED, FullWorkbookError, _sheet_parts,
    combine_full_workbook,
)


def _inputs(directory: Path) -> tuple[Path, Path]:
    resource = files("services.vietnam_replenishment").joinpath("resources/skeleton.xlsx")
    with resource.open("rb") as handle:
        original = load_workbook(handle)
    for index, name in enumerate(UNCHANGED, 1):
        sheet = original.create_sheet(name, index)
        sheet["A1"] = f"original {name}"
        sheet["A1"].font = Font(color="FF336699")
        sheet["B2"] = "=越南备货清单!H2"
        sheet["C3"] = "SKU-PREVIOUS"
    template = directory / "template.xlsx"
    original.save(template)
    original.close()

    with resource.open("rb") as handle:
        fresh = load_workbook(handle)
    fresh["越南备货清单"]["E2"] = "SKU-CURRENT"
    fresh["越南备货清单"]["E2"].font = Font(bold=True, color="FF112233")
    fresh["雅仓库存"]["B2"] = "SKU-CURRENT"
    current = directory / "current.xlsx"
    fresh.save(current)
    fresh.close()
    return template, current


def test_four_unchanged_sheets_keep_exact_xml_and_current_five_are_inserted(tmp_path: Path) -> None:
    template, current = _inputs(tmp_path)
    before = sha256(template.read_bytes()).digest()
    output = tmp_path / "final.xlsx"

    combine_full_workbook(template, current, output)

    assert sha256(template.read_bytes()).digest() == before
    with ZipFile(template) as original, ZipFile(output) as result:
        names = _sheet_parts(original)
        assert result.testzip() is None
        for name in UNCHANGED:
            assert result.read(names[name]) == original.read(names[name])

    book = load_workbook(output, read_only=False, data_only=False)
    try:
        assert tuple(book.sheetnames) == REQUIRED_ORDER
        assert book["越南备货清单"]["E2"].value == "SKU-CURRENT"
        assert book["越南备货清单"]["E2"].font.bold
        assert book["雅仓库存"]["B2"].value == "SKU-CURRENT"
        for name in UNCHANGED:
            assert book[name]["A1"].value == f"original {name}"
            assert book[name]["A1"].font.color.rgb == "FF336699"
            assert book[name]["B2"].value == "=越南备货清单!H2"
            assert book[name]["C3"].value == "SKU-PREVIOUS"
    finally:
        book.close()


def test_bad_sheet_order_is_rejected_without_partial_output(tmp_path: Path) -> None:
    template, current = _inputs(tmp_path)
    book = load_workbook(template)
    book.move_sheet("改库存", offset=1)
    book.save(template)
    book.close()
    output = tmp_path / "final.xlsx"

    with pytest.raises(FullWorkbookError, match="指定顺序的九表"):
        combine_full_workbook(template, current, output)
    assert not output.exists()


def test_template_parameters_use_saved_formula_result_without_a_sku_map(tmp_path: Path) -> None:
    template, _ = _inputs(tmp_path)
    book = load_workbook(template)
    main = book["越南备货清单"]
    for cell, value in {"B2": 2, "E2": "SKU-CURRENT", "G2": 10,
                        "AE2": "=G2*20", "AJ2": None}.items():
        main[cell] = value
    book.save(template)
    book.close()
    cached = tmp_path / "cached.xlsx"
    with ZipFile(template) as source, ZipFile(cached, "w") as target:
        part = _sheet_parts(source)["越南备货清单"]
        for info in source.infolist():
            payload = source.read(info.filename)
            if info.filename == part:
                xml = ET.fromstring(payload)
                cell = xml.find(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c[@r='AE2']")
                cell.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v").text = "200"
                payload = ET.tostring(xml)
            target.writestr(info, payload)
    actual = load_template_sku_parameters(cached, {"SKU-CURRENT", "SKU-NEW"})
    assert actual["SKU-CURRENT"].cost == 10
    assert actual["SKU-CURRENT"].cross_border_price == 200
    assert actual["SKU-CURRENT"].discount_price is None
    assert "SKU-NEW" not in actual


def test_template_conflicting_duplicate_current_sku_is_rejected(tmp_path: Path) -> None:
    template, _ = _inputs(tmp_path)
    book = load_workbook(template)
    main = book["越南备货清单"]
    for row, cost in ((2, 10), (3, 11)):
        for column, value in (("B", 2), ("E", "SKU-CURRENT"), ("G", cost),
                              ("AE", 20), ("AJ", 15)):
            main[f"{column}{row}"] = value
    book.save(template)
    book.close()
    with pytest.raises(AssetContractError, match="参数冲突"):
        load_template_sku_parameters(template, {"SKU-CURRENT"})
