"""Synthetic contracts for Vietnam SKU maps."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

from openpyxl import Workbook
import pytest

from services.vietnam_replenishment.asset_contract import (
    AssetContractError,
    SkuParameters,
    SkuMapValidationError,
    load_sku_parameters,
    validate_usable_sku_parameters,
)


MAP_HEADERS = ("折扣价", "热销标记", "SKU", "成本", "跨境价", "上架时间")


def _sku_map(path: Path, *rows: tuple[object, ...], headers=MAP_HEADERS) -> Path:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "SKU参数"
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    workbook.save(path)
    workbook.close()
    return path


def test_sku_parameters_match_exact_text_sku_and_preserve_explicit_values(tmp_path: Path) -> None:
    path = _sku_map(
        tmp_path / "parameters.xlsx",
        (None, 1, " VN-001 ", 0, 16.5, date(2026, 9, 19)),
        (9.9, 2, "VN-002", 10.25, 20.5, None),
        (None, None, None, None, None, None),
        ("", "", "", "", "", ""),
    )

    result = load_sku_parameters(path)

    assert set(result) == {"VN-001", "VN-002"}
    assert result["VN-001"] == SkuParameters(
        cost=Decimal("0"),
        cross_border_price=Decimal("16.5"),
        discount_price=None,
        hot_flag=1,
        listed_at="2026-09-19",
    )
    assert result["VN-002"] == SkuParameters(
        cost=Decimal("10.25"),
        cross_border_price=Decimal("20.5"),
        discount_price=Decimal("9.9"),
        hot_flag=2,
        listed_at=None,
    )


def test_sku_parameters_keep_internal_sku_characters_and_optional_date(tmp_path: Path) -> None:
    path = _sku_map(
        tmp_path / "parameters.xlsx",
        (None, None, " VN A  01 ", None, None),
        headers=MAP_HEADERS[:-1],
    )

    result = load_sku_parameters(path)

    assert set(result) == {"VN A  01"}
    assert result["VN A  01"].listed_at is None


@pytest.mark.parametrize(
    "listed_at", ["2026-09-19", "2026-09-19 10:00", "2026-09-19T10:00:00+07:00"]
)
def test_sku_parameters_accept_explicit_iso_listed_at_text(
    tmp_path: Path, listed_at: str
) -> None:
    path = _sku_map(
        tmp_path / "listed-at-text.xlsx",
        (None, 1, "VN-001", 3, 5, listed_at),
    )

    assert load_sku_parameters(path)["VN-001"].listed_at == listed_at


@pytest.mark.parametrize(
    "listed_at",
    ["tomorrow", "2026-02-30 10:00", "2026-01-01 nonsense", "2026-01-01 25:00"],
)
def test_sku_parameters_reject_invalid_listed_at_text(
    tmp_path: Path, listed_at: str
) -> None:
    path = _sku_map(tmp_path / "bad-listed-at.xlsx", (None, 1, "VN-001", 3, 5, listed_at))

    with pytest.raises(AssetContractError) as error:
        load_sku_parameters(path)
    assert "F2" in str(error.value)


def test_sku_parameters_reject_duplicate_sku_after_trim(tmp_path: Path) -> None:
    path = _sku_map(
        tmp_path / "duplicate.xlsx",
        (None, 1, "VN-001", 3, 5, None),
        (None, 2, " VN-001 ", 4, 6, None),
    )

    with pytest.raises(AssetContractError) as error:
        load_sku_parameters(path)
    assert "C3" in str(error.value) and "C2" in str(error.value)


@pytest.mark.parametrize(
    ("sku", "expected"),
    [(None, "C2"), (" ", "C2"), (123, "C2")],
)
def test_sku_parameters_reject_nonblank_row_without_text_sku(
    tmp_path: Path, sku: object, expected: str
) -> None:
    path = _sku_map(tmp_path / "bad-sku.xlsx", (None, 1, sku, 3, 5, None))

    with pytest.raises(AssetContractError) as error:
        load_sku_parameters(path)
    assert expected in str(error.value)


@pytest.mark.parametrize("cost", ["not-a-number", -1, "NaN", "Infinity"])
def test_sku_parameters_reject_invalid_numeric_input(tmp_path: Path, cost: object) -> None:
    path = _sku_map(tmp_path / "bad-cost.xlsx", (None, 1, "VN-001", cost, 5, None))

    with pytest.raises(AssetContractError) as error:
        load_sku_parameters(path)
    assert "D2" in str(error.value)


def test_sku_parameters_reject_formula_in_input_cell(tmp_path: Path) -> None:
    path = _sku_map(tmp_path / "formula.xlsx", (None, 1, "VN-001", "=1+1", 5, None))

    with pytest.raises(AssetContractError) as error:
        load_sku_parameters(path)
    assert "D2" in str(error.value)


@pytest.mark.parametrize("hot_flag", [0, 3, "hot"])
def test_sku_parameters_reject_hot_flag_outside_one_or_two(
    tmp_path: Path, hot_flag: object
) -> None:
    path = _sku_map(tmp_path / "bad-hot.xlsx", (None, hot_flag, "VN-001", 3, 5, None))

    with pytest.raises(AssetContractError) as error:
        load_sku_parameters(path)
    assert "B2" in str(error.value)


def test_sku_parameters_require_unique_named_headers(tmp_path: Path) -> None:
    path = _sku_map(
        tmp_path / "duplicate-header.xlsx",
        (None, 1, "VN-001", 3, 5, None),
        headers=("折扣价", "热销标记", "SKU", "成本", "跨境价", "成本"),
    )

    with pytest.raises(AssetContractError) as error:
        load_sku_parameters(path)
    assert "成本" in str(error.value)


def test_sku_parameters_require_every_named_header(tmp_path: Path) -> None:
    path = _sku_map(
        tmp_path / "missing-header.xlsx",
        (None, 1, "VN-001", 3),
        headers=("折扣价", "热销标记", "SKU", "成本"),
    )

    with pytest.raises(AssetContractError, match="缺少表头 '跨境价'"):
        load_sku_parameters(path)


def test_sku_parameters_keep_actual_workbook_read_error(tmp_path: Path) -> None:
    path = tmp_path / "corrupted-map.xlsx"
    path.write_bytes(b"not an xlsx archive")

    with pytest.raises(AssetContractError, match="BadZipFile: File is not a zip file"):
        load_sku_parameters(path)



def test_usable_sku_map_accepts_complete_rows_and_skips_empty_rows(tmp_path: Path) -> None:
    path = _sku_map(
        tmp_path / "valid.xlsx",
        (3, 1, "VN-A", 1, 2),
        (None, None, None, None, None),
        (6, 2, "VN-B", 4, 5),
    )
    values = validate_usable_sku_parameters(path)
    assert set(values) == {"VN-A", "VN-B"}
    assert values["VN-A"] == SkuParameters(
        cost=Decimal(1), cross_border_price=Decimal(2), discount_price=Decimal(3), hot_flag=1,
    )
    assert values["VN-B"].hot_flag == 2


@pytest.mark.parametrize(
    ("column", "label", "invalid"),
    [
        (column, label, invalid)
        for column, label in ((0, "折扣价"), (3, "成本"), (4, "跨境价"))
        for invalid in (0, "0", -1, "NaN", "Infinity", True, "=1+1")
    ] + [(1, "热销标记", invalid) for invalid in (None, " ", 0, 3, 1.5, True)],
)
def test_usable_sku_map_rejects_incomplete_or_invalid_row(
    tmp_path: Path, column: int, label: str, invalid: object,
) -> None:
    row = [3, 1, "VN-A", 1, 2]
    row[column] = invalid
    path = _sku_map(tmp_path / "invalid.xlsx", row)
    with pytest.raises(AssetContractError, match=label):
        validate_usable_sku_parameters(path)


@pytest.mark.parametrize("blank", [None, "", "  "])
def test_usable_sku_map_accepts_individually_or_entirely_blank_amounts(tmp_path, blank):
    path = _sku_map(
        tmp_path / "可选 金额.xlsx",
        (3, 1, "no-cost", blank, 2),
        (3, 2, "no-cross-border", 1, blank),
        (blank, 1, "no-discount", 1, 2),
        (blank, 2, "no-amounts", blank, blank),
    )
    assert validate_usable_sku_parameters(path) == {
        "no-cost": SkuParameters(cross_border_price=Decimal(2), discount_price=Decimal(3), hot_flag=1),
        "no-cross-border": SkuParameters(cost=Decimal(1), discount_price=Decimal(3), hot_flag=2),
        "no-discount": SkuParameters(cost=Decimal(1), cross_border_price=Decimal(2), hot_flag=1),
        "no-amounts": SkuParameters(hot_flag=2),
    }


@pytest.mark.parametrize(
    ("row", "message"),
    [
        ((1, 1, "VN-A", "1234567890123456", 2), "Excel 精度"),
        ((1, 1, "VN-A", "1e-400", 2), "精确写入"),
    ],
)
def test_sku_map_rejects_inexact_nonblank_prices(
    tmp_path: Path, row: tuple[object, ...], message: str,
) -> None:
    path = _sku_map(tmp_path / "bad.xlsx", row)
    with pytest.raises(AssetContractError, match=message):
        validate_usable_sku_parameters(path)


def test_usable_sku_map_rejects_empty_first_sheet(tmp_path: Path) -> None:
    path = _sku_map(tmp_path / "empty.xlsx")
    with pytest.raises(AssetContractError, match="没有 SKU"):
        validate_usable_sku_parameters(path)


def test_collects_every_independent_cell_error_in_sheet_order(tmp_path: Path) -> None:
    path = _sku_map(
        tmp_path / "多处 错误.xlsx",
        (0, None, " VN-A ", -1, "bad", "2026-02-30"),
        ("=1+1", 3, "VN-A", "NaN", True, "tomorrow"),
        (1, 1, 123, "1234567890123456", 2, None),
        (None, None, None, None, None, None),
        (1, 1, "VN-late", 1, "1e-400", None),
    )
    with pytest.raises(SkuMapValidationError) as caught:
        validate_usable_sku_parameters(path)
    error = caught.value
    assert "14 个错误，涉及 4 行" in error.summary
    assert [(issue.row, issue.column) for issue in error.issues] == [
        (2, 1), (2, 2), (2, 4), (2, 5), (2, 6),
        (3, 1), (3, 2), (3, 3), (3, 4), (3, 5), (3, 6),
        (4, 3), (4, 4), (6, 5),
    ]
    assert all(issue.sheet == "SKU参数" for issue in error.issues)
    assert error.issues[0].sku == "VN-A"
    assert error.issues[-1].sku == "VN-late"
    assert "SKU参数!C2" in error.issues[7].reason  # First row is itself invalid.
    assert "InvalidOperation" in error.issues[3].reason
    assert "ValueError" in error.issues[4].reason
    assert "=1+1" in error.issues[5].reason


def test_invalid_sku_does_not_hide_other_fields_or_optional_date(tmp_path: Path) -> None:
    path = _sku_map(tmp_path / "formula sku.xlsx", (0, "no", "=1+1", -1, -1, 123))
    with pytest.raises(SkuMapValidationError) as caught:
        validate_usable_sku_parameters(path)
    assert len(caught.value.issues) == 6
    assert {issue.column for issue in caught.value.issues} == set(range(1, 7))
    assert all(issue.sku is None for issue in caught.value.issues)


def test_reports_all_header_errors_without_misinterpreting_data_rows(tmp_path: Path) -> None:
    path = _sku_map(tmp_path / "headers.xlsx", ("bad", "bad", "bad", "bad"),
                    headers=("SKU", "SKU", "成本", "成本"))
    with pytest.raises(SkuMapValidationError) as caught:
        validate_usable_sku_parameters(path)
    assert caught.value.headers is True
    assert len(caught.value.issues) == 5
    assert {issue.row for issue in caught.value.issues} == {1}
    assert "未检查数据行" in str(caught.value)


def test_corrected_rows_return_exact_values_without_defaults(tmp_path: Path) -> None:
    path = _sku_map(tmp_path / "corrected.xlsx", (0, None, "001", None, 2))
    with pytest.raises(SkuMapValidationError) as caught:
        validate_usable_sku_parameters(path)
    assert len(caught.value.issues) == 2  # Blank cost is valid; zero discount and missing flag are not.
    _sku_map(path, ("1.25", 2, "001", "12.34", "5.67"))
    assert validate_usable_sku_parameters(path) == {"001": SkuParameters(
        cost=Decimal("12.34"), cross_border_price=Decimal("5.67"),
        discount_price=Decimal("1.25"), hot_flag=2,
    )}


def test_numeric_overflow_does_not_hide_later_cell_errors(tmp_path: Path) -> None:
    path = _sku_map(tmp_path / "extreme.xlsx", (0, 1, "VN-A", "1e999999999", 2))
    with pytest.raises(SkuMapValidationError) as caught:
        validate_usable_sku_parameters(path)
    assert len(caught.value.issues) == 2
    assert caught.value.issues[1].field == "成本"
    assert "Overflow" in caught.value.issues[1].reason
