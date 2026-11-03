from __future__ import annotations

from copy import copy
from datetime import date
from importlib.resources import files
import os
from pathlib import Path
import re
import tempfile
from typing import Any

from openpyxl import load_workbook
from openpyxl.utils.cell import column_index_from_string
from openpyxl.utils.cell import get_column_letter
from openpyxl.utils.cell import range_boundaries


SOURCE_SHEET = "巴西"
TEMPLATE_SHEET = "订单标准模板"
SKU_COLUMN = 6  # F
SHIPPING_FIRST_COLUMN = 46  # AT
SHIPPING_LAST_COLUMN = 56  # BD
ORDER_ID_COLUMNS = (1, 2)  # A, B
OUTPUT_SKU_COLUMN = 4  # D
OUTPUT_QUANTITY_COLUMN = 20  # T
REQUIRED_TEMPLATE_HEADERS = {
    1: "*订单编号",
    2: "*交易编号",
    4: "*sku",
    20: "*商品数量",
}
SEA_HEADER = re.compile(r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?:[A-Z])?海运$", re.IGNORECASE)


class BrazilOrderWorkbookError(ValueError):
    """The supplied workbook does not meet the order-import contract."""


def _nearest_occurrence(month: int, day: int, today: date, label: str) -> date:
    possible: list[date] = []
    for year in (today.year - 1, today.year, today.year + 1):
        try:
            possible.append(date(year, month, day))
        except ValueError:
            continue
    if not possible:
        raise BrazilOrderWorkbookError(f"海运日期表头日期无效: {label}")
    distances = {candidate: abs((candidate - today).days) for candidate in possible}
    nearest_distance = min(distances.values())
    nearest = [candidate for candidate, distance in distances.items() if distance == nearest_distance]
    if len(nearest) != 1:
        raise BrazilOrderWorkbookError(f"海运日期表头 {label} 跨年后与当前日期距离相同，无法确定年份")
    return nearest[0]


def _shipping_candidates(sheet: Any, today: date) -> list[tuple[str, str, date]]:
    candidates: list[tuple[str, str, date]] = []
    for column in range(SHIPPING_FIRST_COLUMN, SHIPPING_LAST_COLUMN + 1):
        cell = sheet.cell(1, column)
        label = str(cell.value or "").strip()
        match = SEA_HEADER.fullmatch(label)
        if match is None:
            raise BrazilOrderWorkbookError(
                f"巴西工作表第1行 {cell.coordinate} 海运日期表头缺失或格式无效: {label or '空白'}"
            )
        month, day = int(match.group("month")), int(match.group("day"))
        try:
            selected_date = _nearest_occurrence(month, day, today, label)
        except BrazilOrderWorkbookError as exc:
            raise BrazilOrderWorkbookError(f"{cell.coordinate}: {exc}") from exc
        candidates.append((cell.column_letter, label, selected_date))
    return candidates


def _is_yellow_header(cell: Any) -> bool:
    fill = cell.fill
    if fill.fill_type != "solid":
        return False
    color = fill.fgColor
    if color.type == "indexed":
        return color.indexed == 5
    if color.type != "rgb" or not color.rgb:
        return False
    rgb = color.rgb[-6:]
    try:
        red, green, blue = (int(rgb[offset:offset + 2], 16) for offset in (0, 2, 4))
    except ValueError:
        return False
    return red >= 220 and green >= 180 and blue <= 220 and blue + 25 < min(red, green)


def select_shipping_column(sheet: Any, today: date, override: str | None = None) -> tuple[str, str, date]:
    candidates = _shipping_candidates(sheet, today)
    highlighted = [
        candidate for candidate in candidates
        if _is_yellow_header(sheet.cell(1, column_index_from_string(candidate[0])))
    ]
    priority = highlighted or candidates
    minimum_distance = min(abs((candidate_date - today).days) for _, _, candidate_date in priority)
    nearest = [
        candidate for candidate in priority
        if abs((candidate[2] - today).days) == minimum_distance
    ]
    if override is not None:
        column = str(override).strip().upper()
        selected = [candidate for candidate in nearest if candidate[0] == column]
        if not selected:
            options = ", ".join(f"{item[0]} ({item[1]})" for item in nearest)
            if highlighted:
                raise BrazilOrderWorkbookError(
                    f"指定的海运列 {column} 不是标黄优先列中的最近日期列；当前优先候选列为: {options}"
                )
            raise BrazilOrderWorkbookError(f"指定的海运列 {column} 不是最近日期列；当前最近日期列为: {options}")
        return selected[0]
    if len(nearest) != 1:
        options = ", ".join(f"{item[0]} ({item[1]})" for item in nearest)
        prefix = "标黄海运列中的最近日期并列" if highlighted else "最近海运日期并列"
        raise BrazilOrderWorkbookError(f"{prefix}，请人工选择其中一列: {options}")
    return nearest[0]


def _source_rows(input_path: Path, today: date, shipping_column: str | None) -> tuple[list[tuple[str, Any]], str, str, date]:
    try:
        workbook = load_workbook(input_path, read_only=True, data_only=True)
    except Exception as exc:
        raise BrazilOrderWorkbookError(f"无法读取备货清单 XLSX: {type(exc).__name__}: {exc}") from exc
    try:
        if SOURCE_SHEET not in workbook.sheetnames:
            raise BrazilOrderWorkbookError(f"备货清单缺少必需工作表: {SOURCE_SHEET}")
        sheet = workbook[SOURCE_SHEET]
        sku_header = sheet.cell(1, SKU_COLUMN).value
        if not isinstance(sku_header, str) or sku_header.strip().casefold() != "sku":
            raise BrazilOrderWorkbookError(f"巴西工作表 F1 必须是 SKU 表头，当前为: {sku_header!r}")
        selected_column, header, selected_date = select_shipping_column(sheet, today, shipping_column)
        quantity_column_number = column_index_from_string(selected_column)
        rows: list[tuple[str, Any]] = []
        for row_number, values in enumerate(
            sheet.iter_rows(
                min_row=2,
                max_row=sheet.max_row,
                min_col=SKU_COLUMN,
                max_col=quantity_column_number,
                values_only=True,
            ),
            start=2,
        ):
            sku_value = values[0]
            if sku_value is None or (isinstance(sku_value, str) and not sku_value.strip()):
                continue
            if not isinstance(sku_value, str):
                raise BrazilOrderWorkbookError(f"巴西工作表 F{row_number} SKU 必须是文本: {sku_value!r}")
            rows.append((sku_value, values[quantity_column_number - SKU_COLUMN]))
        if not rows:
            raise BrazilOrderWorkbookError("巴西工作表 F 列没有非空 SKU")
        return rows, selected_column, header, selected_date
    finally:
        workbook.close()


def _set_literal(cell: Any, value: Any) -> None:
    cell.value = value
    if isinstance(value, str):
        cell.data_type = "s"


def _template_resource():
    resource = files("services.mabang.brazil_order_import").joinpath("resources", "template.xlsx")
    return resource.open("rb")


def generate_order_workbook(
    input_xlsx: str | Path,
    output_xlsx: str | Path,
    *,
    today: date,
    shipping_column: str | None = None,
) -> dict[str, Any]:
    """Generate and validate one import row for every nonempty source SKU."""
    input_path = Path(input_xlsx)
    if not input_path.is_file() or input_path.suffix.lower() != ".xlsx":
        raise BrazilOrderWorkbookError("备货清单必须是存在的 .xlsx 文件")
    rows, selected_column, selected_header, selected_date = _source_rows(
        input_path, today, shipping_column
    )
    order_id = f"BR{today:%y%m%d}-H"
    output_path = Path(output_xlsx)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    temporary_path: Path | None = None
    try:
        with _template_resource() as source:
            workbook = load_workbook(source, data_only=False)
        try:
            if TEMPLATE_SHEET not in workbook.sheetnames:
                raise BrazilOrderWorkbookError(f"本地订单模板缺少工作表: {TEMPLATE_SHEET}")
            sheet = workbook[TEMPLATE_SHEET]
            if sheet.max_row < 2:
                raise BrazilOrderWorkbookError("本地订单模板缺少数据行格式和默认值")
            headers = tuple(sheet.cell(1, column).value for column in range(1, sheet.max_column + 1))
            for column, expected in REQUIRED_TEMPLATE_HEADERS.items():
                actual = sheet.cell(1, column).value
                if actual != expected:
                    raise BrazilOrderWorkbookError(
                        f"本地订单模板第1行 {sheet.cell(1, column).coordinate} 表头不匹配: {actual!r}"
                    )
            blueprint_values = [sheet.cell(2, column).value for column in range(1, sheet.max_column + 1)]
            blueprint_styles = [copy(sheet.cell(2, column)._style) for column in range(1, sheet.max_column + 1)]
            blueprint_style_ids = [sheet.cell(2, column).style_id for column in range(1, sheet.max_column + 1)]
            blueprint_height = sheet.row_dimensions[2].height
            auto_filter = sheet.auto_filter.ref
            if auto_filter:
                first_column, first_row, last_column, _ = range_boundaries(auto_filter)
                sheet.auto_filter.ref = (
                    f"{get_column_letter(first_column)}{first_row}:"
                    f"{get_column_letter(last_column)}{len(rows) + first_row}"
                )
            if sheet.max_row > 1:
                sheet.delete_rows(2, sheet.max_row - 1)

            for row_index, (sku, quantity) in enumerate(rows, start=2):
                for column, (default_value, style) in enumerate(zip(blueprint_values, blueprint_styles), start=1):
                    cell = sheet.cell(row_index, column)
                    cell._style = copy(style)
                    if default_value is not None:
                        _set_literal(cell, default_value)
                if blueprint_height is not None:
                    sheet.row_dimensions[row_index].height = blueprint_height
                _set_literal(sheet.cell(row_index, ORDER_ID_COLUMNS[0]), order_id)
                _set_literal(sheet.cell(row_index, ORDER_ID_COLUMNS[1]), order_id)
                _set_literal(sheet.cell(row_index, OUTPUT_SKU_COLUMN), sku)
                _set_literal(sheet.cell(row_index, OUTPUT_QUANTITY_COLUMN), quantity)

            with tempfile.NamedTemporaryFile(
                prefix=f".{output_path.stem}-", suffix=".xlsx", dir=output_path.parent, delete=False
            ) as temporary:
                temporary_path = Path(temporary.name)
            workbook.save(temporary_path)
        finally:
            workbook.close()

        _validate_output(
            temporary_path,
            expected_rows=rows,
            expected_order_id=order_id,
            expected_headers=headers,
            expected_defaults=blueprint_values,
            expected_style_ids=blueprint_style_ids,
            expected_height=blueprint_height,
            expected_auto_filter=sheet.auto_filter.ref,
        )
        os.replace(temporary_path, output_path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    return {
        "output_xlsx": output_path,
        "order_id": order_id,
        "sku_count": len(rows),
        "quantity_value_count": sum(quantity is not None for _, quantity in rows),
        "shipping_column": selected_column,
        "shipping_header": selected_header,
        "shipping_date": selected_date.isoformat(),
    }


def _validate_output(
    path: Path,
    *,
    expected_rows: list[tuple[str, Any]],
    expected_order_id: str,
    expected_headers: tuple[Any, ...],
    expected_defaults: list[Any],
    expected_style_ids: list[int],
    expected_height: float | None,
    expected_auto_filter: str | None,
) -> None:
    check = load_workbook(path, read_only=False, data_only=False)
    try:
        if check.sheetnames != [TEMPLATE_SHEET]:
            raise BrazilOrderWorkbookError("生成文件工作表结构与本地模板不一致")
        sheet = check[TEMPLATE_SHEET]
        if sheet.max_row != len(expected_rows) + 1 or sheet.max_column != len(expected_headers):
            raise BrazilOrderWorkbookError("生成文件行数或列数与输入/模板结构不一致")
        if tuple(sheet.cell(1, column).value for column in range(1, sheet.max_column + 1)) != expected_headers:
            raise BrazilOrderWorkbookError("生成文件表头与本地模板不一致")
        if sheet.auto_filter.ref != expected_auto_filter:
            raise BrazilOrderWorkbookError("生成文件自动筛选范围与数据行数不一致")
        for index, (sku, quantity) in enumerate(expected_rows, start=2):
            for column, expected in enumerate(expected_defaults, start=1):
                if column in (*ORDER_ID_COLUMNS, OUTPUT_SKU_COLUMN, OUTPUT_QUANTITY_COLUMN):
                    continue
                if sheet.cell(index, column).value != expected:
                    raise BrazilOrderWorkbookError(f"生成文件第{index}行默认字段与模板不一致")
            expected_values = {
                ORDER_ID_COLUMNS[0]: expected_order_id,
                ORDER_ID_COLUMNS[1]: expected_order_id,
                OUTPUT_SKU_COLUMN: sku,
                OUTPUT_QUANTITY_COLUMN: quantity,
            }
            for column, expected in expected_values.items():
                if sheet.cell(index, column).value != expected:
                    raise BrazilOrderWorkbookError(f"生成文件第{index}行 {sheet.cell(1, column).value} 校验失败")
            if [sheet.cell(index, column).style_id for column in range(1, sheet.max_column + 1)] != expected_style_ids:
                raise BrazilOrderWorkbookError(f"生成文件第{index}行格式与模板不一致")
            if expected_height is not None and sheet.row_dimensions[index].height != expected_height:
                raise BrazilOrderWorkbookError(f"生成文件第{index}行高度与模板不一致")
    finally:
        check.close()
