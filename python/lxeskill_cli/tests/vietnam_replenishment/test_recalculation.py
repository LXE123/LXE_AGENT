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
import pytest

from services.vietnam_replenishment.asset_contract import SkuParameters
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


def _formula_caches(sources: VietnamSources, config: RecommendationConfig) -> dict[str, object]:
    caches: dict[str, object] = {}
    for row_number, sku in enumerate(sources.skus, 2):
        caches.update({
            f"H{row_number}": 0,
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
            f"W{row_number}": "VN",
            f"X{row_number}": 0,
            f"Y{row_number}": 0,
            f"Z{row_number}": 0,
            f"AF{row_number}": 1,
            f"AG{row_number}": 1,
            f"AH{row_number}": 1,
            f"AI{row_number}": 1,
            f"AK{row_number}": 1,
            f"AL{row_number}": 1,
            f"AM{row_number}": 1,
            f"AA{row_number}": canonical_product_time(sources.products[sku]["创建时间"]),
            f"AB{row_number}": "#DIV/0!",
            f"AC{row_number}": 0,
            f"AV{row_number}": config.day_adjustment_30d,
            f"AW{row_number}": config.day_adjustment_15d,
            f"AX{row_number}": config.day_adjustment_7d,
            f"AY{row_number}": config.exchange_rate,
        })
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
    _set_formula_caches(path, _formula_caches(current_sources, current_config))
    return path


def _edit_formula_workbook(path: Path, edit) -> None:
    workbook = load_workbook(path, data_only=False)
    try:
        edit(workbook)
        workbook.save(path)
    finally:
        workbook.close()
    _set_formula_caches(path, _formula_caches(_sources(), RecommendationConfig()))


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


def test_unrecognized_stock_status_cache_is_rejected(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "unknown-status.xlsx")
    _set_formula_caches(path, {"U2": "未知状态", "H2": -10})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-A.*U2"):
        _validate(path)


def test_missing_unambiguous_model_cache_is_rejected(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "missing-model.xlsx")
    _set_formula_caches(path, {"W2": None})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-A.*W2"):
        _validate(path)


@pytest.mark.parametrize("cached", ("OTHER", 1, "#VALUE!"))
def test_unambiguous_model_cache_must_match_preprocessed_sku(tmp_path: Path, cached: object) -> None:
    path = _calculated_fixture(tmp_path / "wrong-model.xlsx")
    _set_formula_caches(path, {"W2": cached})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-A.*W2"):
        _validate(path)


def test_alphanumeric_model_cache_cannot_be_blank(tmp_path: Path) -> None:
    base = _sources()
    sku = "VN1234"
    sources = replace(
        base,
        skus=(sku,),
        sales={sku: {**base.sales["VN-A"], "SKU": sku}},
        inventory={sku: {**base.inventory["VN-A"], "SKU": sku}},
        products={sku: {**base.products["VN-A"], "SKU": sku}},
        in_transit={sku: base.in_transit["VN-A"]},
    )
    parameters = {sku: _parameters()["VN-A"]}
    path = _calculated_fixture(tmp_path / "blank-alphanumeric-model.xlsx", sources=sources, parameters=parameters)
    _set_formula_caches(path, {"V2": sku, "W2": None})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN1234.*W2"):
        recalculation.validate_recalculated_workbook(
            path, sources=sources, parameters=parameters, config=RecommendationConfig(),
        )
    _set_formula_caches(path, {"W2": "VN12"})
    recalculation.validate_recalculated_workbook(
        path, sources=sources, parameters=parameters, config=RecommendationConfig(),
    )


@pytest.mark.parametrize("coordinate", ("AF2", "AH2"))
def test_financial_cache_text_zero_is_not_numeric(tmp_path: Path, coordinate: str) -> None:
    path = _calculated_fixture(tmp_path / "text-zero.xlsx")
    _set_formula_caches(path, {coordinate: "0"})
    with pytest.raises(recalculation.WorkbookGenerationError, match=f"VN-A.*{coordinate}"):
        _validate(path)


@pytest.mark.parametrize("coordinate", ("H2", "AC2"))
def test_replenishment_cache_text_zero_is_not_numeric(tmp_path: Path, coordinate: str) -> None:
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


def test_packaged_writer_with_two_skus_passes_cached_result_validation(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "output.xlsx")
    _validate(path)


def test_recalculated_custom_seven_parameters_match_input(tmp_path: Path) -> None:
    config = RecommendationConfig(
        day_adjustment_30d=Decimal("1.5"), day_adjustment_15d=Decimal("2.5"),
        day_adjustment_7d=Decimal("3.5"), exchange_rate=Decimal("4000"),
        sales_weight_30d=Decimal("0.2"), sales_weight_15d=Decimal("0.5"),
        sales_weight_7d=Decimal("0.3"),
    )
    path = _calculated_fixture(tmp_path / "custom-config.xlsx", config=config)
    recalculation.validate_recalculated_workbook(
        path, sources=_sources(), parameters=_parameters(), config=config,
    )
    with pytest.raises(recalculation.WorkbookGenerationError, match="参数.*输入"):
        _validate(path)


@pytest.mark.parametrize("coordinate", ("A2", "B2", "C2", "D2", "E2", "F2", "G2"))
def test_recalculated_configuration_cannot_change(tmp_path: Path, coordinate: str) -> None:
    path = _calculated_fixture(tmp_path / "changed-config.xlsx")
    _edit_formula_workbook(path, lambda book: setattr(book["数据更改"][coordinate], "value", 999))
    with pytest.raises(recalculation.WorkbookGenerationError, match="参数.*配置"):
        _validate(path)


@pytest.mark.parametrize("value", ("0.1", "=0.1"))
def test_recalculated_configuration_must_remain_numeric_literal(tmp_path: Path, value: object) -> None:
    path = _calculated_fixture(tmp_path / "nonnumeric-config.xlsx")
    _edit_formula_workbook(path, lambda book: setattr(book["数据更改"]["E2"], "value", value))
    with pytest.raises(recalculation.WorkbookGenerationError, match="E2.*有限数值"):
        _validate(path)


def test_parameter_formula_cache_cannot_be_numeric_text(tmp_path: Path) -> None:
    path = _calculated_fixture(tmp_path / "text-config-cache.xlsx")
    _set_formula_caches(path, {"AV2": "0.8"})
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-A.*AV2.*有限数值"):
        _validate(path)


@pytest.mark.parametrize("formula", (
    "=K3*0.1/(30+AV3)+L3*0.3/(15+AW3)+M3*0.6/(7+AX3)",
    "=K3*数据更改!E3/(30+AV3)+L3*数据更改!F3/(15+AW3)+M3*数据更改!G3/(7+AX3)",
))
def test_sales_weights_require_fixed_config_references(tmp_path: Path, formula: str) -> None:
    path = _calculated_fixture(tmp_path / "wrong-weights.xlsx")
    _edit_formula_workbook(path, lambda book: setattr(book["越南备货清单"]["S3"], "value", formula))
    with pytest.raises(recalculation.WorkbookGenerationError, match="VN-B.*S3"):
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
