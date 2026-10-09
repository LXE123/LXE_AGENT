"""A workbook is published only after managed Office and result checks succeed."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from pathlib import Path
import shutil
from types import SimpleNamespace
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from openpyxl import load_workbook
from openpyxl.formula.translate import Translator
import pytest

from services.vietnam_replenishment.asset_contract import SkuParameters
from services.vietnam_replenishment.formula_dependencies import mapping_formula_blank
from services.vietnam_replenishment.workbook import (
    RecommendationConfig,
    canonical_product_time,
    write_vietnam_workbook,
)
from services.vietnam_replenishment.yacang_sources import VietnamSources
from services.vietnam_replenishment import recalculation


def _sources() -> VietnamSources:
    return VietnamSources(
        skus=("VN-A", "VN-B"),
        sales={
            sku: {"SKU": sku, "仓库": "VN8806", "7天销量": 0, "15天销量": 0, "30天销量": 0}
            for sku in ("VN-A", "VN-B")
        },
        inventory={
            "VN-A": {"SKU": "VN-A", "仓库": "VN8806", "在途数量": 3, "可用库存": 0},
            "VN-B": {"SKU": "VN-B", "仓库": "VN8806", "在途数量": 0, "可用库存": 0},
        },
        products={
            "VN-A": {"SKU": "VN-A", "中文标题": "产品 A", "创建时间": "2026-09-23 10:00"},
            "VN-B": {"SKU": "VN-B", "中文标题": "产品 B", "创建时间": "2024-01-02 03:04"},
        },
        missing_sales=(), missing_inventory=(), missing_products=(),
        in_transit={"VN-A": Decimal("3"), "VN-B": Decimal("0")},
        missing_in_transit=(), in_transit_mismatch=(), artifacts={},
    )


def _parameters() -> dict[str, SkuParameters]:
    return {
        "VN-A": SkuParameters(cost=Decimal("10"), cross_border_price=Decimal("20"), discount_price=Decimal("15")),
        "VN-B": SkuParameters(cost=Decimal("5"), cross_border_price=Decimal("25"), discount_price=Decimal("18")),
    }


def _formula_caches(
    sources: VietnamSources,
    config: RecommendationConfig,
    parameters: dict[str, SkuParameters],
) -> dict[str, object]:
    caches: dict[str, object] = {}
    for row_number, sku in enumerate(sources.skus, 2):
        mapped = parameters.get(sku)
        literals = {
            "B": (2 if mapped.hot_flag is None else mapped.hot_flag) if mapped is not None else None,
            "G": mapped.cost if mapped is not None else None,
            "AE": mapped.cross_border_price if mapped is not None else None,
            "AJ": mapped.discount_price if mapped is not None else None,
        }
        caches.update({
            f"H{row_number}": None if mapped is None else 0,
            f"J{row_number}": 0,
            f"K{row_number}": 0,
            f"L{row_number}": 0,
            f"M{row_number}": 0,
            f"N{row_number}": 0,
            f"O{row_number}": 0,
            f"P{row_number}": 0,
            f"Q{row_number}": "无动销",
            f"R{row_number}": None,
            f"S{row_number}": 0,
            f"T{row_number}": 0,
            f"U{row_number}": "无动销无库存",
            f"V{row_number}": "VN",
            f"X{row_number}": 0,
            f"Y{row_number}": 0,
            f"Z{row_number}": 0,
            f"AA{row_number}": canonical_product_time(sources.products[sku]["创建时间"]),
            f"AB{row_number}": "#DIV/0!",
            f"AC{row_number}": None if mapped is None else 0,
            f"AV{row_number}": config.weight_30d,
            f"AW{row_number}": config.weight_15d,
            f"AX{row_number}": config.weight_7d,
            f"AY{row_number}": config.exchange_rate,
        })
        for column in ("AF", "AG", "AH", "AI", "AK", "AL", "AM"):
            caches[f"{column}{row_number}"] = (
                None if mapping_formula_blank(column, literals) else 1
            )
    return caches


def _set_formula_caches(path: Path, caches: dict[str, object]) -> None:
    namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    ET.register_namespace("", namespace)
    staged = path.with_name("cached.xlsx")
    with ZipFile(path) as source, ZipFile(staged, "w") as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == "xl/worksheets/sheet1.xml":
                root = ET.fromstring(data)
                found: set[str] = set()
                for cell in root.iter(f"{{{namespace}}}c"):
                    coordinate = cell.attrib.get("r")
                    if coordinate not in caches:
                        continue
                    assert cell.find(f"{{{namespace}}}f") is not None, coordinate
                    value = caches[coordinate]
                    if isinstance(value, str):
                        cell.attrib["t"] = "e" if value.startswith("#") else "str"
                    else:
                        cell.attrib.pop("t", None)
                    cached = cell.find(f"{{{namespace}}}v")
                    if cached is None:
                        cached = ET.SubElement(cell, f"{{{namespace}}}v")
                    cached.text = None if value is None else str(value)
                    found.add(coordinate)
                assert found == set(caches)
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            target.writestr(info, data)
    staged.replace(path)


def _calculated_fixture(
    path: Path,
    *,
    sources: VietnamSources | None = None,
    parameters: dict[str, SkuParameters] | None = None,
    config: RecommendationConfig | None = None,
) -> Path:
    current_sources = sources if sources is not None else _sources()
    current_parameters = parameters if parameters is not None else _parameters()
    current_config = config if config is not None else RecommendationConfig()
    write_vietnam_workbook(path, current_sources, current_parameters, current_config)
    _set_formula_caches(path, _formula_caches(current_sources, current_config, current_parameters))
    return path


def _edit_formula_workbook(
    path: Path, edit, *, parameters: dict[str, SkuParameters] | None = None,
) -> None:
    workbook = load_workbook(path, data_only=False)
    try:
        edit(workbook)
        workbook.save(path)
    finally:
        workbook.close()
    current_parameters = parameters if parameters is not None else _parameters()
    _set_formula_caches(path, _formula_caches(_sources(), RecommendationConfig(), current_parameters))


def _validate(path: Path, *, parameters: dict[str, SkuParameters] | None = None) -> None:
    recalculation.validate_recalculated_workbook(
        path, sources=_sources(), parameters=parameters or _parameters(),
        config=RecommendationConfig(),
    )


@pytest.mark.parametrize("coordinate", ("N2", "O2", "P2", "X2", "Y2", "Z2", "AF2", "AH2"))
def test_required_numeric_cache_cannot_be_blank(tmp_path: Path, coordinate: str) -> None:
    path = _calculated_fixture(tmp_path / "missing-cache.xlsx")
    _set_formula_caches(path, {coordinate: None})
    with pytest.raises(recalculation.WorkbookGenerationError, match=f"VN-A.*{coordinate}"):
        _validate(path)


@pytest.mark.parametrize("cached", (None, "未知状态", 0))
def test_trend_cache_must_be_known_text(tmp_path: Path, cached: object) -> None:
    path = _calculated_fixture(tmp_path / "bad-trend.xlsx")
    _set_formula_caches(path, {"Q2": cached})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-A.*Q2"):
        _validate(path)


@pytest.mark.parametrize(("status", "cached"), (("无动销", 1), ("平稳", None), ("平稳", 0.9), ("平稳", "1")))
def test_trend_multiplier_must_match_status(tmp_path: Path, status: str, cached: object) -> None:
    path = _calculated_fixture(tmp_path / "bad-multiplier.xlsx")
    _set_formula_caches(path, {"Q2": status, "R2": cached})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-A.*R2"):
        _validate(path)


@pytest.mark.parametrize(("status", "cached"), (("持续上升", 1.2), ("近期回升", 1.1), ("平稳", 1), ("近期回落", 0.9), ("持续下滑", 0.8)))
def test_valid_trend_multiplier_is_accepted(tmp_path: Path, status: str, cached: object) -> None:
    path = _calculated_fixture(tmp_path / "valid-trend.xlsx")
    _set_formula_caches(path, {"Q2": status, "R2": cached})
    _validate(path)


def test_source_based_category_cache_cannot_be_lost(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "missing-category.xlsx")
    _set_formula_caches(path, {"V2": None})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-A.*V2"):
        _validate(path)


@pytest.mark.parametrize("coordinate", ("AF2", "AH2"))
def test_financial_cache_text_zero_is_not_numeric(tmp_path: Path, coordinate: str) -> None:
    path = _calculated_fixture(tmp_path / "text-zero.xlsx")
    _set_formula_caches(path, {coordinate: "0"})
    with pytest.raises(recalculation.WorkbookGenerationError, match=f"VN-A.*{coordinate}"):
        _validate(path)


@pytest.mark.parametrize("coordinate", ("H2", "S2", "T2", "AC2"))
def test_core_calculation_cache_text_zero_is_not_numeric(tmp_path: Path, coordinate: str) -> None:
    path = _calculated_fixture(tmp_path / "text-replenishment.xlsx")
    _set_formula_caches(path, {coordinate: "0"})
    with pytest.raises(recalculation.WorkbookGenerationError, match=f"VN-A.*{coordinate}"):
        _validate(path)


def test_short_leading_dash_sku_can_have_blank_category(tmp_path: Path) -> None:
    base = _sources()
    sku = "-A"
    sources = replace(
        base,
        skus=(sku,),
        sales={sku: {**base.sales["VN-A"], "SKU": sku}},
        inventory={sku: {**base.inventory["VN-A"], "SKU": sku}},
        products={sku: {**base.products["VN-A"], "SKU": sku}},
        in_transit={sku: base.in_transit["VN-A"]},
    )
    parameters = {sku: _parameters()["VN-A"]}
    path = _calculated_fixture(tmp_path / "blank-category.xlsx", sources=sources, parameters=parameters)
    _set_formula_caches(path, {"V2": None, "W2": None})
    recalculation.validate_recalculated_workbook(
        path, sources=sources, parameters=parameters, config=RecommendationConfig(),
    )


def test_sparse_map_validates_only_independent_and_present_price_results(tmp_path: Path) -> None:
    parameters = {"VN-A": _parameters()["VN-A"]}
    path = _calculated_fixture(tmp_path / "sparse.xlsx", parameters=parameters)
    _validate(path, parameters=parameters)


@pytest.mark.parametrize("coordinate", ("H3", "AC3", "AF3", "AK3"))
@pytest.mark.parametrize("cache", (0, " "))
def test_unmapped_dependent_cache_must_be_empty(
    tmp_path: Path, coordinate: str, cache: object,
) -> None:
    parameters = {"VN-A": _parameters()["VN-A"]}
    path = _calculated_fixture(tmp_path / "wrong-blank-cache.xlsx", parameters=parameters)
    _set_formula_caches(path, {coordinate: cache})
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path, parameters=parameters)
    assert "VN-B" in str(error.value)
    assert coordinate in str(error.value)


def test_unmapped_formula_error_is_not_treated_as_blank(tmp_path: Path) -> None:
    parameters = {"VN-A": _parameters()["VN-A"]}
    path = _calculated_fixture(tmp_path / "error-cache.xlsx", parameters=parameters)
    _set_formula_caches(path, {"AF3": "#VALUE!"})
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path, parameters=parameters)
    assert "VN-B" in str(error.value)
    assert "AF3" in str(error.value)

@pytest.mark.parametrize("coordinate", ("H3", "AF3"))
def test_unmapped_guarded_formula_cannot_be_removed(tmp_path: Path, coordinate: str) -> None:
    parameters = {"VN-A": _parameters()["VN-A"]}
    path = _calculated_fixture(tmp_path / "unguarded.xlsx", parameters=parameters)

    def remove_guard(book):
        original = recalculation._load_skeleton()
        try:
            source_coordinate = f"{coordinate[:-1]}2"
            base = original["越南备货清单"][source_coordinate].value
            book["越南备货清单"][coordinate] = Translator(
                base, origin=source_coordinate,
            ).translate_formula(coordinate)
        finally:
            original.close()

    _edit_formula_workbook(path, remove_guard, parameters=parameters)
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path, parameters=parameters)
    assert "VN-B" in str(error.value)
    assert coordinate in str(error.value)


def test_partial_discount_keeps_other_financial_results_numeric(tmp_path: Path) -> None:
    parameters = _parameters()
    parameters["VN-B"] = replace(parameters["VN-B"], discount_price=None)
    path = _calculated_fixture(tmp_path / "partial-discount.xlsx", parameters=parameters)
    _validate(path, parameters=parameters)
    _set_formula_caches(path, {"AK3": 0})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-B.*AK3"):
        _validate(path, parameters=parameters)


@pytest.mark.parametrize(
    ("missing_field", "blank_columns", "numeric_columns"),
    (
        ("cost", ("AG", "AH", "AL", "AM"), ("AF", "AI", "AK")),
        ("cross_border_price", ("AF", "AG", "AH", "AI"), ("AK", "AL", "AM")),
        ("discount_price", ("AK", "AL", "AM"), ("AF", "AG", "AH", "AI")),
    ),
)
def test_partial_price_dependency_matrix(
    tmp_path: Path, missing_field: str,
    blank_columns: tuple[str, ...], numeric_columns: tuple[str, ...],
) -> None:
    parameters = _parameters()
    parameters["VN-B"] = replace(parameters["VN-B"], **{missing_field: None})
    path = _calculated_fixture(tmp_path / "partial-price.xlsx", parameters=parameters)
    _validate(path, parameters=parameters)
    workbook = load_workbook(path, data_only=True)
    try:
        main = workbook["越南备货清单"]
        assert all(main[f"{column}3"].value is None for column in blank_columns)
        assert all(main[f"{column}3"].value == 1 for column in numeric_columns)
    finally:
        workbook.close()

def test_zero_price_with_missing_cost_still_has_blank_margin(tmp_path: Path) -> None:
    parameters = _parameters()
    parameters["VN-B"] = replace(
        parameters["VN-B"], cost=None,
        cross_border_price=Decimal("0"), discount_price=Decimal("0"),
    )
    path = _calculated_fixture(tmp_path / "zero-with-missing-cost.xlsx", parameters=parameters)
    _validate(path, parameters=parameters)
    workbook = load_workbook(path, data_only=True)
    try:
        main = workbook["越南备货清单"]
        assert main["AE3"].value == 0
        assert main["AJ3"].value == 0
        assert main["AH3"].value is None
        assert main["AM3"].value is None
    finally:
        workbook.close()


def test_packaged_writer_with_two_skus_passes_cached_result_validation(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "output.xlsx")
    _validate(path)


def test_known_zero_sales_available_days_error_is_narrowly_allowed(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "output.xlsx")
    _validate(path)
    _set_formula_caches(path, {"S2": 2})
    with pytest.raises(recalculation.WorkbookGenerationError, match="AB2.*#DIV/0"):
        _validate(path)


@pytest.mark.parametrize("formula", ("=H2", "=ROUNDUP(T2*AC2-J2-AN2,-1)"))
def test_second_sku_wrong_or_cross_row_replenishment_formula_is_rejected(
    tmp_path: Path, formula: str
) -> None:
    path = _calculated_fixture(tmp_path / "wrong-formula.xlsx")
    _edit_formula_workbook(path, lambda book: setattr(book["越南备货清单"]["H3"], "value", formula))
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path)
    assert "VN-B" in str(error.value)
    assert "H3" in str(error.value)


@pytest.mark.parametrize(
    ("sheet", "coordinate", "field"),
    (("雅仓动销", "E3", "7天销量"), ("雅仓库存", "J3", "可用库存")),
)
def test_recalculated_auxiliary_value_must_equal_current_source(
    tmp_path: Path, sheet: str, coordinate: str, field: str
) -> None:
    path = _calculated_fixture(tmp_path / "wrong-auxiliary.xlsx")
    _edit_formula_workbook(path, lambda book: setattr(book[sheet][coordinate], "value", 999))
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path)
    assert "VN-B" in str(error.value)
    assert field in str(error.value)


def test_blank_sku_row_cannot_hide_business_data(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "hidden-row.xlsx")
    _edit_formula_workbook(path, lambda book: setattr(book["雅仓动销"]["E4"], "value", 77))
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path)
    assert "雅仓动销" in str(error.value)
    assert "4" in str(error.value)
    assert "SKU" in str(error.value)


@pytest.mark.parametrize("formula", ("=数据更改!A20", "=数据更改!A2+999"))
def test_parameter_formula_requires_exact_fixed_reference(tmp_path: Path, formula: str) -> None:
    path = _calculated_fixture(tmp_path / "wrong-parameter.xlsx")
    _edit_formula_workbook(path, lambda book: setattr(book["越南备货清单"]["AV3"], "value", formula))
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path)
    assert "VN-B" in str(error.value)
    assert "AV3" in str(error.value)


def test_finite_cached_replenishment_must_match_formula_inputs(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "wrong-cache.xlsx")
    _set_formula_caches(path, {"H3": 10})
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path)
    assert "VN-B" in str(error.value)
    assert "H3" in str(error.value)


@pytest.mark.parametrize(
    ("field", "coordinate", "label"),
    (("cross_border_price", "AH2", "跨境价"), ("discount_price", "AM2", "折扣价")),
)
def test_zero_price_margin_error_names_sku_and_field(
    tmp_path: Path, field: str, coordinate: str, label: str
) -> None:
    parameters = _parameters()
    parameters["VN-A"] = replace(parameters["VN-A"], **{field: Decimal("0")})
    path = _calculated_fixture(tmp_path / "zero-price.xlsx", parameters=parameters)
    _set_formula_caches(path, {coordinate: "#DIV/0!"})
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        _validate(path, parameters=parameters)
    assert "VN-A" in str(error.value)
    assert label in str(error.value)
    assert coordinate in str(error.value)


def test_office_failure_preserves_actual_redacted_diagnostic(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "input.xlsx"
    source.write_bytes(b"not material to mocked process")
    monkeypatch.setenv("LXE_YACANG_PASSWORD", "private-secret")
    monkeypatch.setattr(
        recalculation.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=7, stderr="Kit failed on sheet 2: private-secret", stdout=""
        ),
    )
    with pytest.raises(recalculation.WorkbookGenerationError) as error:
        recalculation.recalculate_with_office(source, tmp_path / "output.xlsx")
    assert "Kit failed on sheet 2" in str(error.value)
    assert "private-secret" not in str(error.value)
    assert "退出码 7" in str(error.value)


def test_failed_generation_leaves_no_final_file(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "result.xlsx"
    monkeypatch.setattr(recalculation, "load_sku_parameters", lambda path: _parameters())
    monkeypatch.setattr(
        recalculation,
        "write_vietnam_workbook",
        lambda path, sources, parameters, config: Path(path).write_bytes(b"draft"),
    )

    def fail_office(_source, _output):
        raise recalculation.WorkbookGenerationError("Kit actual failure")

    monkeypatch.setattr(recalculation, "recalculate_with_office", fail_office)
    with pytest.raises(recalculation.WorkbookGenerationError, match="actual failure"):
        recalculation.generate_vietnam_workbook(
            tmp_path / "map.xlsx", output, sources=_sources()
        )
    assert not output.exists()
    assert not list(tmp_path.glob(".vietnam-workbook-*"))


def test_success_publishes_after_validation_without_overwriting(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "result.xlsx"
    events: list[str] = []
    monkeypatch.setattr(recalculation, "load_sku_parameters", lambda path: _parameters())

    def write(path, sources, parameters, config):
        events.append("write")
        Path(path).write_bytes(b"draft")

    def recalculate(source, target):
        events.append("recalculate")
        shutil.copyfile(source, target)

    def validate(path, **kwargs):
        events.append("validate")
        assert Path(path).read_bytes() == b"draft"
        assert not output.exists()

    monkeypatch.setattr(recalculation, "write_vietnam_workbook", write)
    monkeypatch.setattr(recalculation, "recalculate_with_office", recalculate)
    monkeypatch.setattr(recalculation, "validate_recalculated_workbook", validate)
    assert recalculation.generate_vietnam_workbook(
        tmp_path / "map.xlsx", output, sources=_sources()
    ) == output
    assert events == ["write", "recalculate", "validate"]
    assert output.read_bytes() == b"draft"
    with pytest.raises(FileExistsError):
        recalculation.generate_vietnam_workbook(
            tmp_path / "map.xlsx", output, sources=_sources()
        )
