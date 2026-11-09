from __future__ import annotations

from datetime import date
from pathlib import Path
import re
from typing import Any, Mapping, NamedTuple

from openpyxl.utils import get_column_letter

from .source import nearest_occurrence, read_sku_rows, require_sku_header, source_worksheets
from .workbook import OrderImportWorkbookError, generate_order_workbook


class ShippingCandidate(NamedTuple):
    column: int
    header: str
    shipping_date: date
    field: str
    yellow: bool = False


class CountryRule(NamedTuple):
    name: str
    sheet: str
    sku_column: int
    fields: tuple[str, ...]
    prefix: str
    filename: str
    input_label: str
    dataset_id: str


TRANSPORT_HEADER = re.compile(
    r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?P<batch>[A-Za-z])?(?P<mode>陆运|空运|海运)$",
)
TRANSPORT_NAMES = {"land": "陆运", "air": "空运", "sea": "海运"}
TRANSPORT_FIELDS = {name: field for field, name in TRANSPORT_NAMES.items()}
TRANSPORT_SUFFIXES = {"land": "-L", "air": "-K", "sea": "-H"}
PHILIPPINES_OVERRIDE_FIELDS = {"air", "sea_a", "sea_b"}
RULES = {
    "brazil": CountryRule(
        "巴西", "巴西", 6, ("sea", "land", "air"), "BR",
        "巴西马帮订单导入模板-{order_id}.xlsx", "备货清单", "mabang_brazil_order_import",
    ),
    "malaysia": CountryRule(
        "马来西亚", "马来西亚", 5, ("sea", "air", "land"), "MY",
        "马来西亚马帮订单导入模板-{order_id}.xlsx", "备货清单", "mabang_malaysia_order_import",
    ),
    "vietnam": CountryRule(
        "越南", "越南备货清单", 5, ("land", "sea", "air"), "VN",
        "越南马帮订单导入模板-{order_id}.xlsx", "越南备货清单", "mabang_vietnam_order_import",
    ),
    "philippines": CountryRule(
        "菲律宾", "菲律宾备货清单", 5, ("air", "sea", "land"), "PH",
        "菲律宾马帮订单导入模板-{order_id}.xlsx", "菲律宾备货清单", "mabang_philippines_order_import",
    ),
    "indonesia": CountryRule(
        "印尼", "印尼", 5, ("land", "air", "sea"), "IN",
        "印尼马帮订单导入模板-{order_id}.xlsx", "印尼备货清单", "mabang_indonesia_order_import",
    ),
}
DATASET_IDS = {country: rule.dataset_id for country, rule in RULES.items()}
COUNTRIES = tuple(RULES)


def _rule(country: str) -> CountryRule:
    try:
        return RULES[country]
    except (KeyError, TypeError) as exc:
        raise OrderImportWorkbookError(f"country 仅支持: {', '.join(COUNTRIES)}") from exc


def _is_yellow_header(cell: Any) -> bool:
    fill = cell.fill
    if fill.patternType != "solid" or fill.fgColor.tint:
        return False
    color = fill.fgColor
    if color.type == "rgb":
        rgb = color.rgb
    elif color.type == "indexed":
        palette = cell.parent.parent._colors
        index = color.indexed
        rgb = palette[index] if isinstance(index, int) and 0 <= index < len(palette) else None
    else:
        return False
    return isinstance(rgb, str) and rgb[-6:].upper() == "FFFF00"


def _scan_candidates(rule: CountryRule, sheet: Any, today: date) -> list[ShippingCandidate]:
    candidates: list[ShippingCandidate] = []
    for cell in sheet[1]:
        label = str(cell.value or "").strip()
        if not label:
            continue
        match = TRANSPORT_HEADER.fullmatch(label)
        if match is None:
            if re.match(r"^[0-9]", label) and label.endswith(tuple(TRANSPORT_FIELDS)):
                raise OrderImportWorkbookError(
                    f"{rule.name}工作表第1行 {cell.coordinate} 运输日期字段格式无效: {label}"
                )
            continue
        field = TRANSPORT_FIELDS[match.group("mode")]
        batch = match.group("batch")
        if batch is not None:
            field += f"_{batch.lower()}"
        shipping_date = nearest_occurrence(
            int(match.group("month")), int(match.group("day")), today,
            country=rule.name, label=f"{cell.coordinate}: {label}",
        )
        candidates.append(ShippingCandidate(cell.column, label, shipping_date, field, _is_yellow_header(cell)))
    return candidates


def _transport_output(field: str) -> tuple[str, str]:
    mode, _, batch = field.partition("_")
    return batch.upper() + TRANSPORT_NAMES[mode], batch.upper() + TRANSPORT_SUFFIXES[mode]


def _closest_candidates(candidates: list[ShippingCandidate], today: date) -> list[ShippingCandidate]:
    closest = min(
        (item.shipping_date for item in candidates),
        key=lambda day: (abs((day - today).days), -day.toordinal()),
    )
    return [item for item in candidates if item.shipping_date == closest]


def _select_nearest_per_transport(
    rule: CountryRule, candidates: list[ShippingCandidate], overrides: Mapping[str, str], today: date,
) -> dict[str, ShippingCandidate]:
    if not candidates:
        raise OrderImportWorkbookError(f"{rule.name}工作表没有可识别的陆运、空运或海运日期字段")
    nearest_candidates: dict[str, list[ShippingCandidate]] = {}
    for mode in rule.fields:
        options = [item for item in candidates if item.field.partition("_")[0] == mode]
        if not options:
            continue
        distance = min(abs((item.shipping_date - today).days) for item in options)
        fields = {item.field for item in options if abs((item.shipping_date - today).days) == distance}
        fields.update(item.field for item in options if item.yellow)
        for field in fields:
            nearest_candidates[field] = _closest_candidates([item for item in options if item.field == field], today)

    for field, column in overrides.items():
        choices = nearest_candidates.get(field, [])
        if not isinstance(column, str) or not column.strip():
            raise OrderImportWorkbookError("指定运输列必须是有效的表格列名")
        if not any(get_column_letter(item.column) == column.strip().upper() for item in choices):
            name, _ = _transport_output(field)
            raise OrderImportWorkbookError(f"{rule.name}指定的 {name} 运输列 {column} 不是离当天最近的候选列")

    selected: dict[str, ShippingCandidate] = {}
    for mode in rule.fields:
        for field in sorted(key for key in nearest_candidates if key.partition("_")[0] == mode):
            choices = nearest_candidates[field]
            override = overrides.get(field)
            if override is not None:
                selected[field] = next(item for item in choices if get_column_letter(item.column) == override.strip().upper())
            elif len(choices) == 1:
                selected[field] = choices[0]
            else:
                name, _ = _transport_output(field)
                columns = "、".join(f"{get_column_letter(item.column)}1 ({item.header})" for item in choices)
                raise OrderImportWorkbookError(
                    f"{rule.name}工作表 {name} 在该批次离当天最近的日期 "
                    f"{choices[0].shipping_date.isoformat()} 字段重复：{columns}"
                )
    return selected


def select_shipping_columns(
    country: str,
    sheet: Any,
    today: date,
    *,
    shipping_column: str | None = None,
    shipping_columns: Mapping[str, str] | None = None,
) -> dict[str, ShippingCandidate]:
    rule = _rule(country)
    if country not in {"brazil", "vietnam"} and shipping_column is not None:
        raise OrderImportWorkbookError("shipping_column 仅用于巴西或越南备货清单")
    if country != "philippines" and shipping_columns:
        raise OrderImportWorkbookError("按运输方式指定列仅用于菲律宾备货清单")
    overrides = dict(shipping_columns or {})
    if country == "philippines" and set(overrides) - PHILIPPINES_OVERRIDE_FIELDS:
        raise OrderImportWorkbookError("菲律宾运输列选择包含未知运输方式")
    candidates = _scan_candidates(rule, sheet, today)
    if shipping_column is not None:
        if not isinstance(shipping_column, str) or not shipping_column.strip():
            raise OrderImportWorkbookError("指定运输列必须是有效的表格列名")
        column = shipping_column.strip().upper()
        match = next((item for item in candidates if get_column_letter(item.column) == column), None)
        if match is None:
            raise OrderImportWorkbookError(f"指定的运输列 {column} 不是离当天最近的候选列")
        overrides[match.field] = column
    return _select_nearest_per_transport(rule, candidates, overrides, today)


def generate_order_workbooks(
    country: str,
    input_xlsx: str | Path,
    output_directory: str | Path,
    *,
    today: date,
    template_path: str | Path,
    shipping_column: str | None = None,
    shipping_columns: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    rule = _rule(country)
    with source_worksheets(Path(input_xlsx), rule.sheet, input_label=rule.input_label) as (sheet, formula_sheet):
        require_sku_header(sheet, rule.sku_column, rule.name)
        selected = select_shipping_columns(
            country, sheet, today, shipping_column=shipping_column, shipping_columns=shipping_columns,
        )
        # Malaysia's prior reader checked fields in source-column order.
        read_order = sorted(selected.items(), key=lambda item: item[1].column) if country == "malaysia" else selected.items()
        rows = read_sku_rows(
            sheet,
            formula_sheet,
            sku_column=rule.sku_column,
            quantity_columns={field: candidate.column for field, candidate in read_order},
            country=rule.name,
        )

    artifacts: list[dict[str, Any]] = []
    for field, candidate in selected.items():
        _, suffix = _transport_output(field)
        order_id = f"{rule.prefix}{today:%y%m%d}{suffix}"
        output = Path(output_directory) / rule.filename.format(order_id=order_id)
        result = generate_order_workbook(
            [(sku, quantities[field]) for sku, quantities in rows],
            output,
            order_id=order_id,
            template_path=template_path,
        )
        artifact = {**result}
        if country in {"malaysia", "philippines", "indonesia"}:
            artifact["field"] = field
        artifact.update({
            "shipping_column": get_column_letter(candidate.column) if country == "brazil" else candidate.column,
            "shipping_header": candidate.header,
            "shipping_date": candidate.shipping_date.isoformat(),
        })
        if country in {"vietnam", "philippines", "indonesia"}:
            artifact["shipping_mode"] = _transport_output(field)[0]
        artifacts.append(artifact)
    return artifacts
