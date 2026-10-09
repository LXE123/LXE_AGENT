"""Read-only validation of the full Vietnam business template."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
import re

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter


REQUIRED_SHEETS = (
    "越南备货清单",
    "雅仓库存",
    "雅仓动销",
    "数据更改",
    "库存商品信息",
)

MAIN_HEADERS = {
    "B1": "判断热销",
    "E1": "SKU",
    "G1": "成本",
    "H1": "陆运",
    "AA1": "上架时间",
    "AE1": "跨境价",
    "AJ1": "折扣价",
    "AN1": "总在途",
    "AV1": "30天",
    "AW1": "15天",
    "AX1": "7天",
    "AY1": "汇率",
}

AUXILIARY_HEADERS = {
    "雅仓库存": {"B1": "SKU", "F1": "库存数量", "H1": "在途数量", "J1": "可用库存"},
    "雅仓动销": {"A1": "SKU", "E1": "7天销量", "F1": "15天销量", "G1": "30天销量"},
    "数据更改": {"A1": "30天", "B1": "15天", "C1": "7天", "D1": "汇率"},
    "库存商品信息": {"B1": "SKU", "K1": "创建时间"},
}

MAIN_PARAMETER_REFERENCES = {"AV2": "A2", "AW2": "B2", "AX2": "C2", "AY2": "D2"}


class AssetContractError(ValueError):
    """A supplied workbook cannot serve as the Vietnam business template."""


@dataclass(frozen=True)
class TemplateContract:
    sheet_names: tuple[str, ...]
    main_rows: int


@dataclass(frozen=True)
class SkuParameters:
    cost: Decimal | None = None
    cross_border_price: Decimal | None = None
    discount_price: Decimal | None = None
    hot_flag: int | None = None
    listed_at: str | None = None


def validate_template(path: str | Path) -> TemplateContract:
    """Check structural prerequisites without modifying the supplied workbook."""
    try:
        workbook = load_workbook(path, read_only=True, data_only=False)
    except Exception as exc:
        raise AssetContractError(f"读取模板失败: {type(exc).__name__}: {exc}") from exc

    try:
        sheet_names = tuple(workbook.sheetnames)
        for name in REQUIRED_SHEETS:
            if name not in sheet_names:
                raise AssetContractError(f"缺少工作表: {name}")

        for sheet_name, headers in {
            REQUIRED_SHEETS[0]: MAIN_HEADERS,
            **AUXILIARY_HEADERS,
        }.items():
            sheet = workbook[sheet_name]
            for coordinate, expected in headers.items():
                actual = sheet[coordinate].value
                if actual != expected:
                    raise AssetContractError(
                        f"{sheet_name}!{coordinate}: "
                        f"期望表头 {expected!r}，实际为 {actual!r}"
                    )

        main = workbook[REQUIRED_SHEETS[0]]
        change = workbook["数据更改"]
        for main_coordinate, source_coordinate in MAIN_PARAMETER_REFERENCES.items():
            input_cell = change[source_coordinate]
            if input_cell.data_type == "f":
                raise AssetContractError(
                    f"数据更改!{source_coordinate}: 参数输入格不能是公式，"
                    f"实际为 {input_cell.value!r}"
                )

            formula_cell = main[main_coordinate]
            source_column = source_coordinate[0]
            source_row = source_coordinate[1:]
            reference = (
                rf"(?:'数据更改'|数据更改)!\$?{source_column}\$?{source_row}(?![0-9])"
            )
            formula = formula_cell.value
            if formula_cell.data_type != "f" or not re.search(reference, str(formula)):
                raise AssetContractError(
                    f"越南备货清单!{main_coordinate}: 公式必须引用 "
                    f"数据更改!{source_coordinate}，实际为 {formula!r}"
                )

        main_rows = sum(
            1
            for (sku,) in main.iter_rows(min_row=2, min_col=5, max_col=5, values_only=True)
            if sku is not None and str(sku).strip()
        )
        return TemplateContract(sheet_names=sheet_names, main_rows=main_rows)
    except AssetContractError:
        raise
    except Exception as exc:
        raise AssetContractError(f"读取模板失败: {type(exc).__name__}: {exc}") from exc
    finally:
        workbook.close()


_PARAMETER_HEADERS = ("SKU", "成本", "跨境价", "折扣价", "热销标记")


def _blank(value: object) -> bool:
    return value is None or isinstance(value, str) and not value.strip()


def load_sku_parameters(path: str | Path) -> dict[str, SkuParameters]:
    """Read explicit SKU inputs from the first sheet; never infer missing values."""
    try:
        workbook = load_workbook(path, read_only=True, data_only=False)
    except Exception as exc:
        raise AssetContractError(f"读取 SKU 参数表失败: {type(exc).__name__}: {exc}") from exc

    try:
        sheet = workbook.worksheets[0]
        name = sheet.title
        first_row = next(sheet.iter_rows(min_row=1, max_row=1), ())
        columns: dict[str, int] = {}
        for index, cell in enumerate(first_row, 1):
            if not isinstance(cell.value, str) or not cell.value.strip():
                continue
            header = cell.value.strip()
            if header in columns:
                raise AssetContractError(
                    f"{name}!{get_column_letter(index)}1: 重复表头 {header!r}"
                )
            columns[header] = index
        for header in _PARAMETER_HEADERS:
            if header not in columns:
                raise AssetContractError(f"{name}!1: 缺少表头 {header!r}")

        def cell_at(row: tuple, row_number: int, header: str):
            column = columns[header]
            cell = row[column - 1]
            coordinate = f"{name}!{get_column_letter(column)}{row_number}"
            if cell.data_type == "f":
                raise AssetContractError(f"{coordinate}: {header} 输入格不能是公式，实际为 {cell.value!r}")
            return cell.value, coordinate

        def number_at(row: tuple, row_number: int, header: str) -> Decimal | None:
            value, coordinate = cell_at(row, row_number, header)
            if _blank(value):
                return None
            if isinstance(value, bool):
                raise AssetContractError(f"{coordinate}: {header} 必须是有限非负数，实际为布尔值")
            try:
                result = Decimal(str(value))
            except (InvalidOperation, ValueError, TypeError) as exc:
                raise AssetContractError(
                    f"{coordinate}: {header} 不是数字: {type(exc).__name__}: {exc}"
                ) from exc
            if not result.is_finite() or result < 0:
                raise AssetContractError(f"{coordinate}: {header} 必须是有限非负数")
            return result

        result: dict[str, SkuParameters] = {}
        first_rows: dict[str, int] = {}
        for row_number, row in enumerate(sheet.iter_rows(min_row=2), 2):
            if all(_blank(cell.value) for cell in row):
                continue
            sku_value, sku_coordinate = cell_at(row, row_number, "SKU")
            if not isinstance(sku_value, str) or not sku_value.strip():
                raise AssetContractError(f"{sku_coordinate}: SKU 必须是非空文本")
            sku = sku_value.strip()
            if sku in result:
                original = f"{name}!{get_column_letter(columns['SKU'])}{first_rows[sku]}"
                raise AssetContractError(f"{sku_coordinate}: SKU 与 {original} 重复")

            cost = number_at(row, row_number, "成本")
            cross_border_price = number_at(row, row_number, "跨境价")
            discount_price = number_at(row, row_number, "折扣价")
            hot_value = number_at(row, row_number, "热销标记")
            if hot_value is not None and hot_value not in (1, 2):
                coordinate = f"{name}!{get_column_letter(columns['热销标记'])}{row_number}"
                raise AssetContractError(f"{coordinate}: 热销标记只能是 1 或 2")

            listed_at = None
            if "上架时间" in columns:
                listed_value, coordinate = cell_at(row, row_number, "上架时间")
                if not _blank(listed_value):
                    if isinstance(listed_value, str):
                        listed_at = listed_value.strip()
                        if not re.match(r"^\d{4}-\d{2}-\d{2}(?:$|[ T])", listed_at):
                            raise AssetContractError(
                                f"{coordinate}: 上架时间文本必须以 ISO YYYY-MM-DD 开头"
                            )
                        try:
                            if len(listed_at) == 10:
                                date.fromisoformat(listed_at)
                            else:
                                datetime.fromisoformat(listed_at)
                        except ValueError as exc:
                            raise AssetContractError(
                                f"{coordinate}: 上架时间日期或时间无效: {type(exc).__name__}: {exc}"
                            ) from exc
                    elif isinstance(listed_value, date):
                        listed_cell = row[columns["上架时间"] - 1]
                        listed_at = (
                            listed_value.date().isoformat()
                            if isinstance(listed_value, datetime)
                            and listed_cell.number_format == "yyyy-mm-dd"
                            else str(listed_value).strip()
                        )
                    else:
                        raise AssetContractError(f"{coordinate}: 上架时间必须是文本或日期")

            result[sku] = SkuParameters(
                cost=cost,
                cross_border_price=cross_border_price,
                discount_price=discount_price,
                hot_flag=int(hot_value) if hot_value is not None else None,
                listed_at=listed_at,
            )
            first_rows[sku] = row_number
        return result
    except AssetContractError:
        raise
    except Exception as exc:
        raise AssetContractError(f"读取 SKU 参数表失败: {type(exc).__name__}: {exc}") from exc
    finally:
        workbook.close()


__all__ = [
    "AssetContractError",
    "SkuParameters",
    "TemplateContract",
    "load_sku_parameters",
    "validate_template",
]
