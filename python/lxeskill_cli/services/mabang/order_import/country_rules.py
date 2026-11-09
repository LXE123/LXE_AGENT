from __future__ import annotations

from datetime import date
from pathlib import Path
import re
from typing import Any, Mapping, NamedTuple, Pattern

from openpyxl.utils import get_column_letter

from .source import nearest_occurrence, read_sku_rows, require_sku_header, source_worksheets
from .workbook import OrderImportWorkbookError, generate_order_workbook


class ShippingCandidate(NamedTuple):
    column: int
    header: str
    shipping_date: date
    field: str


class CountryRule(NamedTuple):
    name: str
    sheet: str
    sku_column: int
    header: Pattern[str]
    policy: str
    fields: tuple[str, ...]
    prefix: str
    filename: str
    input_label: str
    dataset_id: str


SEA_HEADER = re.compile(r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?:[A-Z])?海运$", re.IGNORECASE)
LAND_SEA_HEADER = re.compile(r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?P<mode>陆运|海运)$")
AIR_SEA_HEADER = re.compile(
    r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?P<batch>[AB])?(?P<kind>空运|海运)$",
    re.IGNORECASE,
)
TRANSPORT_HEADER = re.compile(
    r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?P<batch>[A-Za-z])?(?P<mode>陆运|空运|海运)$",
)
TRANSPORT_NAMES = {"land": "陆运", "air": "空运", "sea": "海运"}
TRANSPORT_FIELDS = {name: field for field, name in TRANSPORT_NAMES.items()}
TRANSPORT_SUFFIXES = {"land": "-L", "air": "-K", "sea": "-H"}
FIELD_NAMES = {"air": "空运", "sea_a": "A海运", "sea_b": "B海运"}
FIELD_SUFFIX = {"air": "-K", "sea_a": "A-H", "sea_b": "B-H"}
RULES = {
    "brazil": CountryRule(
        "巴西", "巴西", 6, SEA_HEADER, "nearest", ("selected",), "BR",
        "巴西马帮订单导入模板-{order_id}.xlsx", "备货清单", "mabang_brazil_order_import",
    ),
    "malaysia": CountryRule(
        "马来西亚", "马来西亚", 5, AIR_SEA_HEADER, "latest_group", ("sea_a", "sea_b", "air"), "MY",
        "马来西亚马帮订单导入模板-{order_id}.xlsx", "备货清单", "mabang_malaysia_order_import",
    ),
    "vietnam": CountryRule(
        "越南", "越南备货清单", 5, LAND_SEA_HEADER, "nearest", ("selected",), "VN",
        "越南马帮订单导入模板-{order_id}.xlsx", "越南备货清单", "mabang_vietnam_order_import",
    ),
    "philippines": CountryRule(
        "菲律宾", "菲律宾备货清单", 5, AIR_SEA_HEADER, "nearest_per_field", ("air", "sea_a", "sea_b"), "PH",
        "菲律宾马帮订单导入模板-{order_id}.xlsx", "菲律宾备货清单", "mabang_philippines_order_import",
    ),
    "indonesia": CountryRule(
        "印尼", "印尼", 5, TRANSPORT_HEADER, "latest_per_transport", ("land", "air", "sea"), "IN",
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


def _scan_candidates(country: str, rule: CountryRule, sheet: Any, today: date) -> list[ShippingCandidate]:
    cells = (sheet.cell(1, column) for column in range(46, 57)) if country == "brazil" else sheet[1]
    candidates: list[ShippingCandidate] = []
    seen: dict[tuple[date, str], ShippingCandidate] = {}
    for cell in cells:
        label = str(cell.value or "").strip()
        if not label and country != "brazil":
            continue
        match = rule.header.fullmatch(label)
        if match is None:
            if country == "brazil":
                # Empty read-only cells need not have a coordinate attribute.
                column = 46 + len(candidates)
                raise OrderImportWorkbookError(
                    f"巴西工作表第1行 {get_column_letter(column)}1 海运日期表头缺失或格式无效: {label or '空白'}"
                )
            modes = ("陆运", "海运") if country == "vietnam" else ("空运", "海运")
            if rule.policy == "latest_per_transport":
                invalid_transport = bool(re.match(r"^[0-9]", label)) and label.endswith(tuple(TRANSPORT_FIELDS))
            else:
                invalid_transport = "/" in label and any(mode in label for mode in modes)
            if invalid_transport:
                raise OrderImportWorkbookError(
                    f"{rule.name}工作表第1行 {cell.coordinate} 运输日期字段格式无效: {label}"
                )
            continue

        if rule.policy == "latest_per_transport":
            field = TRANSPORT_FIELDS[match.group("mode")]
            batch = match.group("batch")
            if batch is not None:
                field += f"_{batch.lower()}"
        elif country == "brazil":
            field = "海运"
        elif country == "vietnam":
            field = match.group("mode")
        else:
            batch, kind = match.group("batch"), match.group("kind")
            if kind == "空运" and batch is None:
                field = "air"
            elif kind == "海运" and batch is not None:
                field = {"A": "sea_a", "B": "sea_b"}[batch.upper()]
            else:
                raise OrderImportWorkbookError(
                    f"{rule.name}工作表第1行 {cell.coordinate} 运输字段缺少有效批次标记: {label}"
                )
        shipping_date = nearest_occurrence(
            int(match.group("month")), int(match.group("day")), today,
            country=rule.name, label=f"{cell.coordinate}: {label}",
            defer_year_tie=rule.policy not in {"latest_group", "latest_per_transport"},
        )
        candidate = ShippingCandidate(cell.column, label, shipping_date, field)
        if country == "malaysia":
            key = (shipping_date, field)
            if key in seen:
                raise OrderImportWorkbookError(
                    f"马来西亚工作表 {shipping_date.isoformat()} 的 {label} 字段重复："
                    f"{seen[key].header} 与 {cell.coordinate}"
                )
            seen[key] = candidate
        candidates.append(candidate)
    return candidates


def _nearest(candidates: list[ShippingCandidate], today: date) -> list[ShippingCandidate]:
    distance = min(abs((item.shipping_date - today).days) for item in candidates)
    return [item for item in candidates if abs((item.shipping_date - today).days) == distance]


def _strict_year(candidate: ShippingCandidate, today: date, rule: CountryRule) -> None:
    nearest_occurrence(
        candidate.shipping_date.month, candidate.shipping_date.day, today,
        country=rule.name, label=f"{get_column_letter(candidate.column)}1: {candidate.header}",
    )


def _select_one(
    country: str, rule: CountryRule, candidates: list[ShippingCandidate], today: date,
    override: str | None,
) -> dict[str, ShippingCandidate]:
    if not candidates:
        raise OrderImportWorkbookError("越南工作表没有可识别的 M/D陆运 或 M/D海运 日期字段")
    nearest = _nearest(candidates, today)
    if country == "brazil":
        choices = ", ".join(f"{get_column_letter(item.column)} ({item.header})" for item in nearest)
    else:
        choices = ", ".join(f"{item.header} ({get_column_letter(item.column)})" for item in nearest)
    if override is not None:
        column = str(override).strip().upper()
        matches = [item for item in nearest if get_column_letter(item.column) == column]
        if not matches:
            if country == "brazil":
                raise OrderImportWorkbookError(f"指定的海运列 {column} 不是最近日期列；当前最近日期列为: {choices}")
            raise OrderImportWorkbookError(f"指定的运输列 {column} 不是最近日期候选列；当前候选为: {choices}")
        chosen = matches[0]
    elif len(nearest) != 1:
        if country == "brazil":
            raise OrderImportWorkbookError(f"最近海运日期并列，请人工选择其中一列: {choices}")
        raise OrderImportWorkbookError(f"最近运输日期并列，请人工选择其中一列: {choices}")
    else:
        chosen = nearest[0]
    _strict_year(chosen, today, rule)
    return {"selected": chosen}


def _select_latest_group(rule: CountryRule, candidates: list[ShippingCandidate]) -> dict[str, ShippingCandidate]:
    if not candidates:
        raise OrderImportWorkbookError("马来西亚工作表没有可识别的空运/A海运/B海运日期字段")
    latest = max(item.shipping_date for item in candidates)
    group = {item.field: item for item in candidates if item.shipping_date == latest}
    missing = [field for field in rule.fields if field not in group]
    if missing:
        raise OrderImportWorkbookError(
            f"最新日期组 {latest.isoformat()} 缺少字段: {', '.join(FIELD_NAMES[field] for field in missing)}"
        )
    return {field: group[field] for field in rule.fields}


def _transport_output(field: str) -> tuple[str, str]:
    mode, _, batch = field.partition("_")
    return batch.upper() + TRANSPORT_NAMES[mode], batch.upper() + TRANSPORT_SUFFIXES[mode]


def _select_latest_per_transport(
    rule: CountryRule, candidates: list[ShippingCandidate],
) -> dict[str, ShippingCandidate]:
    if not candidates:
        raise OrderImportWorkbookError(f"{rule.name}工作表没有可识别的陆运、空运或海运日期字段")
    selected: dict[str, ShippingCandidate] = {}
    for mode in rule.fields:
        options = [item for item in candidates if item.field.partition("_")[0] == mode]
        if not options:
            continue
        latest = max(item.shipping_date for item in options)
        group: dict[str, ShippingCandidate] = {}
        for item in options:
            if item.shipping_date != latest:
                continue
            previous = group.get(item.field)
            if previous is not None:
                name, _ = _transport_output(item.field)
                raise OrderImportWorkbookError(
                    f"{rule.name}工作表最新{TRANSPORT_NAMES[mode]}日期 {latest.isoformat()} 的 "
                    f"{name} 字段重复："
                    f"{get_column_letter(previous.column)}1 ({previous.header}) 与 "
                    f"{get_column_letter(item.column)}1 ({item.header})"
                )
            group[item.field] = item
        selected.update((field, group[field]) for field in sorted(group))
    return selected


def _select_per_field(
    rule: CountryRule, candidates: list[ShippingCandidate], today: date,
    overrides: Mapping[str, str],
) -> dict[str, ShippingCandidate]:
    selected: dict[str, ShippingCandidate] = {}
    unresolved: list[str] = []
    for field in rule.fields:
        options = [item for item in candidates if item.field == field]
        name = FIELD_NAMES[field]
        if not options:
            raise OrderImportWorkbookError(f"菲律宾工作表没有可识别的 {name} 日期字段")
        nearest = _nearest(options, today)
        choices = ", ".join(f"{item.header} ({get_column_letter(item.column)})" for item in nearest)
        override = overrides.get(field)
        if override is not None:
            if not isinstance(override, str) or not override.strip():
                raise OrderImportWorkbookError(f"菲律宾 {name} 指定运输列必须是有效的表格列名")
            normalized = override.strip().upper()
            matches = [item for item in nearest if get_column_letter(item.column) == normalized]
            if not matches:
                raise OrderImportWorkbookError(
                    f"菲律宾 {name} 指定的运输列 {normalized} 不是最近日期候选列；当前候选为: {choices}"
                )
            chosen = matches[0]
        elif len(nearest) != 1:
            unresolved.append(f"{name}: {choices}")
            continue
        else:
            chosen = nearest[0]
        _strict_year(chosen, today, rule)
        selected[field] = chosen
    if unresolved:
        raise OrderImportWorkbookError(f"菲律宾最近运输日期并列，请为每种运输选择一列: {'；'.join(unresolved)}")
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
    overrides = shipping_columns or {}
    if country == "philippines" and set(overrides) - set(rule.fields):
        raise OrderImportWorkbookError("菲律宾运输列选择包含未知运输方式")
    candidates = _scan_candidates(country, rule, sheet, today)
    if rule.policy == "nearest":
        return _select_one(country, rule, candidates, today, shipping_column)
    if rule.policy == "latest_group":
        return _select_latest_group(rule, candidates)
    if rule.policy == "latest_per_transport":
        return _select_latest_per_transport(rule, candidates)
    return _select_per_field(rule, candidates, today, overrides)


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
        if rule.policy == "latest_per_transport":
            _, suffix = _transport_output(field)
        elif country == "brazil":
            suffix = "-H"
        elif country == "vietnam":
            suffix = {"陆运": "-L", "海运": "-H"}[candidate.field]
        else:
            suffix = FIELD_SUFFIX[field]
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
        if rule.policy == "latest_per_transport":
            artifact["shipping_mode"] = _transport_output(field)[0]
        elif country == "vietnam":
            artifact["shipping_mode"] = candidate.field
        elif country == "philippines":
            artifact["shipping_mode"] = FIELD_NAMES[field]
        artifacts.append(artifact)
    return artifacts
